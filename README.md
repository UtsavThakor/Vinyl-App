# Vinyl Spotify Controller

A tiny Expo web app that turns Spotify playback into a vinyl-style controller.

## Spotify setup

In the Spotify Developer Dashboard, add redirect URIs for every place you use the app:

- `http://127.0.0.1:8081`
- `https://your-vercel-project.vercel.app`

Spotify matches these exactly. If you see `redirect_uri: Not matching configuration`, copy the exact URL the app is using into the dashboard. For this local preview, that is `http://127.0.0.1:8081`.

The app uses Authorization Code with PKCE, so the Spotify client ID is public and no client secret is needed in the browser.

## Environment

The current client ID is kept as a fallback in `src/spotify.ts`. To override it on Vercel or locally, set:

```bash
EXPO_PUBLIC_SPOTIFY_CLIENT_ID=your_spotify_client_id
```

You can also pin the redirect URI when needed:

```bash
EXPO_PUBLIC_SPOTIFY_REDIRECT_URI=http://127.0.0.1:8081
```

## Local development

```bash
npm install
npm run web
```

Open the local app as `http://127.0.0.1:8081`, even if Expo prints a `localhost` URL. Spotify no longer accepts `localhost` redirect URIs.

## Vercel deploy

Vercel should use:

- Build command: `npm run build`
- Output directory: `dist`
- Install command: `npm install`

These are also defined in `vercel.json`.

## Notes

Spotify playback control endpoints require a Spotify account/device that can be controlled through the Web API. Start Spotify on a device first, then use the vinyl gestures:

- Swipe right on the record: next track
- Swipe left once: restart track
- Swipe left twice quickly: previous track
- Pull the cover down: repeat current track
- Push the cover up: turn repeat off
