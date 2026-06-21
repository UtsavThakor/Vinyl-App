import * as AuthSession from 'expo-auth-session';
import { Platform } from 'react-native';

// Your Spotify app's Client ID (safe to keep here — it's public)
export const CLIENT_ID = '67a5c76247934c708705a4029cea6c37';

// Permissions our app needs
export const SCOPES = [
  'user-read-currently-playing',
  'user-read-playback-state',
  'user-modify-playback-state',
];

// Spotify's auth endpoints
export const DISCOVERY = {
  authorizationEndpoint: 'https://accounts.spotify.com/authorize',
  tokenEndpoint: 'https://accounts.spotify.com/api/token',
};

// Spotify requires 127.0.0.1 (not localhost) for loopback redirect URIs.
// On a real device we use the custom scheme instead.
export const REDIRECT_URI =
  Platform.OS === 'web'
    ? 'http://127.0.0.1:8081'
    : AuthSession.makeRedirectUri({ scheme: 'vinylapp', path: 'callback' });