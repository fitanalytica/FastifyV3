// docs/data/api.md section 6. The server enforces only hard caps; the phone prepares the files to much smaller targets (about 3 MB, 25 MB, 1 MB).

export type Role = 'photo' | 'video' | 'poster';

/** The most bytes a file of each role may have. Generous on purpose: the phone's own targets are lower and come from its settings. */
export const MAX_BYTES: Record<Role, number> = { photo: 5 * 1024 * 1024, video: 40 * 1024 * 1024, poster: 2 * 1024 * 1024 };

/** Content type -> the extension the file is saved with. A photo or a poster is WebP (JPEG is accepted for a phone that cannot encode WebP); a video is MP4. */
export const EXTENSION: Record<Role, Record<string, string>> = {
  photo: { 'image/webp': 'webp', 'image/jpeg': 'jpg' },
  poster: { 'image/webp': 'webp', 'image/jpeg': 'jpg' },
  video: { 'video/mp4': 'mp4' },
};

/** The most photos and videos one activity may have. */
export const MAX_MEDIA_PER_ACTIVITY = 20;

/** How long an upload address works. */
export const UPLOAD_URL_SECONDS = 900;

/** Profile pictures and covers (docs/data/api.md section 7b): the kind of image and the hard caps on its size. The phone prepares them far smaller. */
export type ProfileImageKind = 'pic' | 'bg';
export const PROFILE_MAX_BYTES: Record<ProfileImageKind, number> = { pic: 1024 * 1024, bg: 3 * 1024 * 1024 };
export const PROFILE_EXTENSION: Record<string, string> = { 'image/webp': 'webp', 'image/jpeg': 'jpg' };
/** The `userinfo` column that holds each kind's file name. */
export const PROFILE_COLUMN: Record<ProfileImageKind, 'profilepic' | 'profilebg'> = { pic: 'profilepic', bg: 'profilebg' };
