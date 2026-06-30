import * as AuthSession from 'expo-auth-session';
import { Platform } from 'react-native';

// Spotify app Client IDs are public in PKCE flows.
export const CLIENT_ID =
  process.env.EXPO_PUBLIC_SPOTIFY_CLIENT_ID || '67a5c76247934c708705a4029cea6c37';

// Permissions our app needs
export const SCOPES = [
  'user-read-currently-playing',
  'user-read-playback-state',
  'user-modify-playback-state',
  'user-library-read',
  'playlist-read-private',
];

// Spotify's auth endpoints
export const DISCOVERY = {
  authorizationEndpoint: 'https://accounts.spotify.com/authorize',
  tokenEndpoint: 'https://accounts.spotify.com/api/token',
};

function getWebRedirectUri() {
  if (process.env.EXPO_PUBLIC_SPOTIFY_REDIRECT_URI) {
    return process.env.EXPO_PUBLIC_SPOTIFY_REDIRECT_URI;
  }

  if (typeof window === 'undefined') return 'http://127.0.0.1:8081';

  const { hostname, port, protocol } = window.location;
  if (hostname === 'localhost') {
    return `${protocol}//127.0.0.1${port ? `:${port}` : ''}`;
  }

  return window.location.origin;
}

export const REDIRECT_URI =
  Platform.OS === 'web'
    ? getWebRedirectUri()
    : AuthSession.makeRedirectUri({ scheme: 'vinylapp', path: 'callback' });
