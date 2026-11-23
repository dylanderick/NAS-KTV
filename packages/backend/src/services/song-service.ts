import { eq, like, and, sql, desc, inArray } from 'drizzle-orm';
import fs from 'fs';
import { rm } from 'fs/promises';
import path from 'path';
import { db, schema } from '../db';
import { config } from '../config';
import logger from '../logger';
import { deleteArtistIfOrphan, UNKNOWN_ARTIST_NAME } from './song-info-parser';

const { songs, artists, songCategories, categoryItems, songArtists } = schema;

/**
 * 统计某歌手参与的歌曲数量（主歌手或副歌手）
 */
export function countArtistSongs(artistId: number): number {
  return (
    db
      .select({
        count: sql<number>`count(*)`,
      })
      .from(songs)
      .where(
        sql`${songs.artistId} = ${artistId} OR EXISTS (
          SELECT 1 FROM ${songArtists} sa
          WHERE sa.song_id = ${sql.raw('songs.id')} AND sa.artist_id = ${artistId}
        )`,
      )
      .get()?.count ?? 0
  );
}

/**
 * 批量查询歌曲的全部歌手名（含主歌手，按 position 排序），供列表展示与歌手搜索
 */
export function getArtistNamesBySong(songIds: number[]): Map<number, string[]> {
  const map = new Map<number, string[]>();
  if (songIds.length === 0) return map;

  const rows = db
    .select({
      songId: songArtists.songId,
      artistName: artists.name,
    })
    .from(songArtists)
    .innerJoin(artists, eq(songArtists.artistId, artists.id))
    .where(inArray(songArtists.songId, songIds))
    .orderBy(sql`${songArtists.songId}, ${songArtists.position}`)
    .all();

  for (const row of rows) {
    if (!row.songId || !row.artistName) continue;
    const list = map.get(row.songId) ?? [];
    if (!list.includes(row.artistName)) list.push(row.artistName);
    map.set(row.songId, list);
  }
  return map;
}

export type AiParseFilterStatus =
  | 'unparsed'
  | 'parsed'
  | 'need_review'
  | 'manual_edited'
  | 'reviewed';

export type SeparationFilterStatus =
  | 'none'
  | 'processing'
  | 'completed'
  | 'failed';

export type TranscodeFilterStatus =
  | 'none'
  | 'pending'
  | 'processing'
  | 'completed'
  | 'failed';

export type FileTypeFilter = 'audio' | 'video';
export type LyricsFilterStatus = 'has_lyrics' | 'no_lyrics';

export interface GetSongsParams {
  page?: number;
  pageSize?: number;
  keyword?: string;
  artistId?: number;
  categoryItemIds?: number[];
  /** 分类组 ID：筛选该分类组下所有分类项关联的歌曲 */
  categoryId?: number;
  /** AI 解析状态（全库筛选） */
  aiParseStatus?: AiParseFilterStatus;
  /** 人声分离状态（全库筛选） */
  separationStatus?: SeparationFilterStatus;
  /** 视频转码状态（全库筛选） */
  transcodeStatus?: TranscodeFilterStatus;
  /** 媒体文件类型（audio / video，全库筛选） */
  fileType?: FileTypeFilter;
  /** 歌词状态（has_lyrics / no_lyrics，全库筛选） */
  lyricsStatus?: LyricsFilterStatus;
}

export async function getSongs(params: GetSongsParams) {
  const {
    page = 1,
    pageSize = 20,
    keyword,
    artistId,
    categoryItemIds,
    categoryId,
    aiParseStatus,
    separationStatus,
    transcodeStatus,
    fileType,
    lyricsStatus,
  } = params;
  const offset = (page - 1) * pageSize;

  const conditions = [];

  if (keyword) {
    const pattern = `%${keyword}%`;
    conditions.push(
      sql`(${songs.title} LIKE ${pattern} OR ${artists.name} LIKE ${pattern} OR ${artists.pinyin} LIKE ${pattern}
        OR EXISTS (
          SELECT 1 FROM ${songArtists} sa
          JOIN ${artists} a2 ON a2.id = sa.artist_id
          WHERE sa.song_id = ${sql.raw('songs.id')} AND (a2.name LIKE ${pattern} OR a2.pinyin LIKE ${pattern})
        ))`
    );
  }

  if (artistId) {
    conditions.push(
      sql`(${songs.artistId} = ${artistId} OR EXISTS (
        SELECT 1 FROM ${songArtists} sa
        WHERE sa.song_id = ${sql.raw('songs.id')} AND sa.artist_id = ${artistId}
      ))`
    );
  }

  if (categoryItemIds && categoryItemIds.length > 0) {
    conditions.push(
      inArray(
        songs.id,
        db.select({ id: songCategories.songId })
          .from(songCategories)
          .where(inArray(songCategories.categoryItemId, categoryItemIds))
      )
    );
  }

  if (categoryId) {
    conditions.push(
      sql`EXISTS (
        SELECT 1 FROM ${songCategories} sc
        JOIN ${categoryItems} ci ON ci.id = sc.category_item_id
        WHERE sc.song_id = ${sql.raw('songs.id')} AND ci.category_id = ${categoryId}
      )`
    );
  }

  if (aiParseStatus) {
    switch (aiParseStatus) {
      case 'unparsed':
        conditions.push(sql`(${songs.aiParsed} IS NULL OR ${songs.aiParsed} = 0)`);
        break;
      case 'parsed':
        conditions.push(eq(songs.aiParsed, 1));
        break;
      case 'need_review':
        conditions.push(sql`(${songs.aiParsed} = 2 AND ${songs.aiNeedReview} = 1)`);
        break;
      case 'manual_edited':
        conditions.push(sql`(${songs.aiParsed} = 1 AND ${songs.aiManualEdited} = 1)`);
        break;
      case 'reviewed':
        conditions.push(
          sql`(${songs.aiParsed} = 2 AND (${songs.aiNeedReview} IS NULL OR ${songs.aiNeedReview} = 0))`,
        );
        break;
    }
  }

  if (separationStatus) {
    switch (separationStatus) {
      case 'none':
        conditions.push(
          sql`(${songs.separationStatus} IS NULL OR ${songs.separationStatus} = '' OR ${songs.separationStatus} = 'none' OR ${songs.separationStatus} = 'pending')`,
        );
        break;
      case 'processing':
        conditions.push(eq(songs.separationStatus, 'processing'));
        break;
      case 'completed':
        conditions.push(eq(songs.separationStatus, 'completed'));
        break;
      case 'failed':
        conditions.push(eq(songs.separationStatus, 'failed'));
        break;
    }
  }

  if (transcodeStatus) {
    switch (transcodeStatus) {
      case 'none':
        conditions.push(
          sql`(${songs.fileType} = 'video' AND (${songs.transcodeStatus} IS NULL OR ${songs.transcodeStatus} = '' OR ${songs.transcodeStatus} = 'none'))`,
        );
        break;
      case 'pending':
        conditions.push(eq(songs.transcodeStatus, 'pending'));
        break;
      case 'processing':
        conditions.push(eq(songs.transcodeStatus, 'processing'));
        break;
      case 'completed':
        conditions.push(eq(songs.transcodeStatus, 'completed'));
        break;
      case 'failed':
        conditions.push(eq(songs.transcodeStatus, 'failed'));
        break;
    }
  }

  if (fileType === 'audio' || fileType === 'video') {
    conditions.push(eq(songs.fileType, fileType));
  }

  if (lyricsStatus) {
    if (lyricsStatus === 'has_lyrics') {
      conditions.push(sql`(${songs.lyricsPath} IS NOT NULL AND length(${songs.lyricsPath}) > 0)`);
    } else if (lyricsStatus === 'no_lyrics') {
      conditions.push(sql`(${songs.lyricsPath} IS NULL OR length(${songs.lyricsPath}) = 0)`);
    }
  }

  const whereClause = conditions.length > 0 ? and(...conditions) : undefined;

  const countResult = await db
    .select({ count: sql<number>`count(*)` })
    .from(songs)
    .leftJoin(artists, eq(songs.artistId, artists.id))
    .where(whereClause);

  const total = countResult[0]?.count ?? 0;

  const items = await db
    .select({
      id: songs.id,
      title: songs.title,
      artistId: songs.artistId,
      albumId: songs.albumId,
      filePath: songs.filePath,
      fileType: songs.fileType,
      duration: songs.duration,
      lyricsPath: songs.lyricsPath,
      pitchDefault: songs.pitchDefault,
      playCount: songs.playCount,
      createdAt: songs.createdAt,
      vocalsPath: songs.vocalsPath,
      instrumentalPath: songs.instrumentalPath,
      separationStatus: songs.separationStatus,
      transcodeStatus: songs.transcodeStatus,
      aiParsed: songs.aiParsed,
      aiNeedReview: songs.aiNeedReview,
      aiManualEdited: songs.aiManualEdited,
      artistName: artists.name,
      artistPinyin: artists.pinyin,
    })
    .from(songs)
    .leftJoin(artists, eq(songs.artistId, artists.id))
    .where(whereClause)
    .orderBy(desc(songs.createdAt), desc(songs.id))
    .limit(pageSize)
    .offset(offset);

  const songIds = items.map((s) => s.id);
  let categoriesBySong: Map<
    number,
    Array<{
      categoryId: number | null;
      categoryName: string | null;
      categoryItemId: number | null;
      categoryItemName: string | null;
    }>
  > = new Map();

  if (songIds.length > 0) {
    const categoriesResult = await db
      .select({
        songId: songCategories.songId,
        categoryId: categoryItems.categoryId,
        categoryName: sql<string>`(SELECT name FROM categories WHERE id = ${categoryItems.categoryId})`,
        categoryItemId: categoryItems.id,
        categoryItemName: categoryItems.name,
      })
      .from(songCategories)
      .leftJoin(categoryItems, eq(songCategories.categoryItemId, categoryItems.id))
      .where(sql`${songCategories.songId} IN ${songIds}`);

    categoriesBySong = new Map();
    for (const row of categoriesResult) {
      if (!row.songId) continue;
      const list = categoriesBySong.get(row.songId) ?? [];
      list.push({
        categoryId: row.categoryId,
        categoryName: row.categoryName,
        categoryItemId: row.categoryItemId,
        categoryItemName: row.categoryItemName,
      });
      categoriesBySong.set(row.songId, list);
    }
  }

  const artistNamesBySong = getArtistNamesBySong(songIds);

  return {
    items: items.map((s) => ({
      ...s,
      categories: categoriesBySong.get(s.id) ?? [],
      artistNames:
        artistNamesBySong.get(s.id)?.length
          ? artistNamesBySong.get(s.id)!
          : s.artistName
            ? [s.artistName]
            : [],
    })),
    total,
    page,
    pageSize,
  };
}

/**
 * 热门歌曲：按播放次数倒序（公开）
 */
export async function getHotSongs(limit = 20) {
  const items = await db
    .select({
      id: songs.id,
      title: songs.title,
      artistId: songs.artistId,
      albumId: songs.albumId,
      filePath: songs.filePath,
      fileType: songs.fileType,
      duration: songs.duration,
      lyricsPath: songs.lyricsPath,
      pitchDefault: songs.pitchDefault,
      playCount: songs.playCount,
      createdAt: songs.createdAt,
      vocalsPath: songs.vocalsPath,
      instrumentalPath: songs.instrumentalPath,
      separationStatus: songs.separationStatus,
      aiParsed: songs.aiParsed,
      aiNeedReview: songs.aiNeedReview,
      aiManualEdited: songs.aiManualEdited,
      artistName: artists.name,
      artistPinyin: artists.pinyin,
    })
    .from(songs)
    .leftJoin(artists, eq(songs.artistId, artists.id))
    .orderBy(desc(songs.playCount), desc(songs.createdAt))
    .limit(limit);

  return items;
}

export async function getSongById(id: number) {
  const result = await db
    .select({
      id: songs.id,
      title: songs.title,
      artistId: songs.artistId,
      albumId: songs.albumId,
      filePath: songs.filePath,
      fileType: songs.fileType,
      duration: songs.duration,
      lyricsPath: songs.lyricsPath,
      pitchDefault: songs.pitchDefault,
      playCount: songs.playCount,
      createdAt: songs.createdAt,
      vocalsPath: songs.vocalsPath,
      instrumentalPath: songs.instrumentalPath,
      separationStatus: songs.separationStatus,
      separationModel: songs.separationModel,
      separationStartedAt: songs.separationStartedAt,
      separationCompletedAt: songs.separationCompletedAt,
      separationError: songs.separationError,
      aiParsed: songs.aiParsed,
      aiParsedAt: songs.aiParsedAt,
      aiConfidence: songs.aiConfidence,
      aiNeedReview: songs.aiNeedReview,
      rawTags: songs.rawTags,
      artistName: artists.name,
      artistPinyin: artists.pinyin,
      artistAvatar: artists.avatar,
    })
    .from(songs)
    .leftJoin(artists, eq(songs.artistId, artists.id))
    .where(eq(songs.id, id))
    .limit(1);

  if (!result[0]) {
    return null;
  }

  const categoriesResult = await db
    .select({
      categoryId: categoryItems.categoryId,
      categoryName: sql<string>`(SELECT name FROM categories WHERE id = ${categoryItems.categoryId})`,
      categoryItemId: categoryItems.id,
      categoryItemName: categoryItems.name,
    })
    .from(songCategories)
    .leftJoin(categoryItems, eq(songCategories.categoryItemId, categoryItems.id))
    .where(eq(songCategories.songId, id));

  const artistNamesMap = getArtistNamesBySong([id]);
  const artistNames =
    artistNamesMap.get(id)?.length
      ? artistNamesMap.get(id)!
      : result[0].artistName
        ? [result[0].artistName]
        : [];

  const artistIds = db
    .select({ artistId: songArtists.artistId })
    .from(songArtists)
    .where(eq(songArtists.songId, id))
    .orderBy(sql`${songArtists.position}`)
    .all()
    .map((r) => r.artistId)
    .filter((aid): aid is number => aid != null);

  return {
    ...result[0],
    categories: categoriesResult,
    artistNames,
    artistIds,
  };
}

/**
 * 设置歌曲的全部歌手（含主歌手，按顺序写入 song_artists，position 保持选择顺序）
 * 主歌手（songs.artist_id）取第一个
 */
export async function setSongArtists(songId: number, artistIds: number[]): Promise<void> {
  await db.delete(songArtists).where(eq(songArtists.songId, songId));

  if (artistIds.length === 0) return;

  await db.insert(songArtists).values(
    artistIds.map((artistId, position) => ({ songId, artistId, position })),
  );
}

export interface UpdateSongData {
  title?: string;
  artistId?: number;
  /** 全部歌手 id（按顺序）：会重建 song_artists 关联；传空数组清空歌手 */
  artistIds?: number[];
  lyricsPath?: string;
  filePath?: string;
  fileType?: 'audio' | 'video';
  duration?: number;
  pitchDefault?: number;
}

export async function updateSong(id: number, data: UpdateSongData) {
  const { artistIds, ...songData } = data;

  if (artistIds !== undefined) {
    // 记录旧歌手关联，替换后被移除的歌手若无其他歌曲关联则直接删除
    const oldArtistIds = db
      .select({ artistId: songArtists.artistId })
      .from(songArtists)
      .where(eq(songArtists.songId, id))
      .all()
      .map((r) => r.artistId)
      .filter((id): id is number => id != null);

    songData.artistId = artistIds[0] ?? null;
    await setSongArtists(id, artistIds);

    for (const aid of oldArtistIds) {
      if (!artistIds.includes(aid)) {
        await deleteArtistIfOrphan(aid);
      }
    }
  }

  const result = await db
    .update(songs)
    .set(songData)
    .where(eq(songs.id, id))
    .returning();

  return result[0] || null;
}

export async function deleteSong(id: number) {
  // 先清理所有引用 songs.id 的外键记录，否则 foreign_keys=ON 下删除会失败
  await db.delete(songCategories).where(eq(songCategories.songId, id));
  await db.delete(songArtists).where(eq(songArtists.songId, id));
  await db.delete(schema.separationTasks).where(eq(schema.separationTasks.songId, id));
  await db.delete(schema.aiParseTasks).where(eq(schema.aiParseTasks.songId, id));
  await db.delete(schema.roomQueues).where(eq(schema.roomQueues.songId, id));
  await db.delete(schema.playlistSongs).where(eq(schema.playlistSongs.songId, id));
  const result = await db.delete(songs).where(eq(songs.id, id)).returning();
  if (result[0]) {
    await cleanupSeparationOutput(id);
  }
  return result[0] || null;
}

/**
 * 删除歌曲时清理其分离产物目录 data/separation/song_<id>
 * （仅清理分离 mp3 成品，保留歌词与源音频文件）
 */
async function cleanupSeparationOutput(songId: number) {
  const dir = path.join(config.separationOutputDir, `song_${songId}`);
  try {
    await rm(dir, { recursive: true, force: true });
    logger.info(`Deleted separation output for song ${songId}: ${dir}`);
  } catch (err) {
    logger.warn(`Failed to delete separation output for song ${songId}: ${dir}`, err);
  }
}

/**
 * 清洗文件名片段（移除 Linux/Windows/SMB 非法文件名字符）
 */
function sanitizeFilenamePart(value: string): string {
  return value
    .replace(/[\/\\:*?"<>|\x00-\x1f]/g, '_')
    .replace(/\s{2,}/g, ' ')
    .trim()
    .replace(/^[.\s]+|[.\s]+$/g, '');
}

export interface RenameSongFileResult {
  songId: number;
  renamed: boolean;
  oldFilePath: string;
  filePath: string;
  lyricsPath: string | null;
  reason?: string;
}

/**
 * 按「歌手-标题.xxx」重命名歌曲原文件（及同目录下的同名 .lrc 歌词文件），并同步更新数据库路径。
 * 多歌手使用「、」连接，如「周杰伦、费玉清-千里之外.mkv」。
 */
export async function renameSongFileToArtistTitle(songId: number): Promise<RenameSongFileResult> {
  const song = db.select().from(songs).where(eq(songs.id, songId)).get();
  if (!song || !song.filePath) {
    return {
      songId,
      renamed: false,
      oldFilePath: song?.filePath ?? '',
      filePath: song?.filePath ?? '',
      lyricsPath: song?.lyricsPath ?? null,
      reason: 'song_not_found',
    };
  }

  const oldFilePath = song.filePath;
  const artistMap = getArtistNamesBySong([songId]);
  let artistNames = artistMap.get(songId) ?? [];
  if (artistNames.length === 0 && song.artistId) {
    const primaryArtist = db
      .select({ name: artists.name })
      .from(artists)
      .where(eq(artists.id, song.artistId))
      .get();
    if (primaryArtist?.name) {
      artistNames = [primaryArtist.name];
    }
  }

  const validArtists = artistNames
    .map((n) => sanitizeFilenamePart(n))
    .filter((n) => n.length > 0 && n !== UNKNOWN_ARTIST_NAME);
  const cleanTitle = sanitizeFilenamePart(song.title || '');

  if (validArtists.length === 0 || !cleanTitle) {
    return {
      songId,
      renamed: false,
      oldFilePath,
      filePath: oldFilePath,
      lyricsPath: song.lyricsPath ?? null,
      reason: 'missing_artist_or_title',
    };
  }

  const dir = path.dirname(oldFilePath);
  const ext = path.extname(oldFilePath);
  const targetBase = `${validArtists.join('、')}-${cleanTitle}`;
  let newFilePath = path.join(dir, `${targetBase}${ext}`);

  if (newFilePath === oldFilePath) {
    return {
      songId,
      renamed: false,
      oldFilePath,
      filePath: oldFilePath,
      lyricsPath: song.lyricsPath ?? null,
      reason: 'already_named',
    };
  }

  if (!fs.existsSync(oldFilePath)) {
    return {
      songId,
      renamed: false,
      oldFilePath,
      filePath: oldFilePath,
      lyricsPath: song.lyricsPath ?? null,
      reason: 'file_missing',
    };
  }

  // 若目标文件已存在且不是同一个 inode，自动追加序号避免覆盖其他歌曲
  if (fs.existsSync(newFilePath)) {
    try {
      const oldStat = fs.statSync(oldFilePath);
      const newStat = fs.statSync(newFilePath);
      if (oldStat.ino !== newStat.ino) {
        let suffix = 2;
        while (fs.existsSync(path.join(dir, `${targetBase} (${suffix})${ext}`))) {
          suffix++;
        }
        newFilePath = path.join(dir, `${targetBase} (${suffix})${ext}`);
      }
    } catch {
      // ignore stat error
    }
  }

  try {
    fs.renameSync(oldFilePath, newFilePath);
  } catch (err) {
    logger.error({ err, songId, oldFilePath, newFilePath }, 'Failed to rename song source file');
    return {
      songId,
      renamed: false,
      oldFilePath,
      filePath: oldFilePath,
      lyricsPath: song.lyricsPath ?? null,
      reason: err instanceof Error ? err.message : 'rename_failed',
    };
  }

  let updatedLyricsPath = song.lyricsPath ?? null;
  const finalBase = path.basename(newFilePath, ext);
  const candidateOldLyrics =
    updatedLyricsPath && fs.existsSync(updatedLyricsPath)
      ? updatedLyricsPath
      : (() => {
          const siblingLrc = path.join(dir, `${path.basename(oldFilePath, ext)}.lrc`);
          return fs.existsSync(siblingLrc) ? siblingLrc : null;
        })();

  if (candidateOldLyrics && path.dirname(candidateOldLyrics) === dir) {
    const targetLrc = path.join(dir, `${finalBase}.lrc`);
    if (targetLrc !== candidateOldLyrics && !fs.existsSync(targetLrc)) {
      try {
        fs.renameSync(candidateOldLyrics, targetLrc);
        updatedLyricsPath = targetLrc;
      } catch (err) {
        logger.warn({ err, songId, candidateOldLyrics, targetLrc }, 'Failed to rename sidecar lrc file');
      }
    } else if (targetLrc === candidateOldLyrics) {
      updatedLyricsPath = targetLrc;
    }
  }

  db.update(songs)
    .set({
      filePath: newFilePath,
      lyricsPath: updatedLyricsPath,
    })
    .where(eq(songs.id, songId))
    .run();

  logger.info(`Renamed song ${songId} file: ${oldFilePath} -> ${newFilePath}`);
  return {
    songId,
    renamed: true,
    oldFilePath,
    filePath: newFilePath,
    lyricsPath: updatedLyricsPath,
  };
}
