import { Linking } from 'react-native';

// The music shortcut (Lyfta-style): the app never plays or reads music, it
// just jumps the user to their player in one tap. Scheme-first for an instant
// app switch; the web player is the fallback when no app claims the scheme
// (the store app usually intercepts the https link anyway).

export type MusicApp = 'off' | 'spotify' | 'apple' | 'ytmusic';

export const MUSIC_APPS: { key: Exclude<MusicApp, 'off'>; label: string; scheme: string; web: string }[] = [
  { key: 'spotify', label: 'Spotify', scheme: 'spotify://', web: 'https://open.spotify.com' },
  { key: 'apple', label: 'Apple Music', scheme: 'music://', web: 'https://music.apple.com' },
  { key: 'ytmusic', label: 'YouTube Music', scheme: 'youtubemusic://', web: 'https://music.youtube.com' },
];

export async function openMusicApp(app: MusicApp): Promise<void> {
  const def = MUSIC_APPS.find((m) => m.key === app);
  if (!def) return;
  try {
    await Linking.openURL(def.scheme);
  } catch {
    Linking.openURL(def.web).catch(() => {});
  }
}
