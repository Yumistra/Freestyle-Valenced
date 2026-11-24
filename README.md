# Freestyle

Plugins for Valenced.

| Plugin | ID |
| --- | --- |
| Better Animations | `yumistra.better-animations` |
| Intelligent Compression | `yumistra.intelligent-compression` |
| Message Actions | `yumistra.message-actions` |
| Everything Logger | `yumistra.everything-logger` |
| Overlay Background | `yumistra.overlay-background` |
| Silent Messages | `yumistra.silent-messages` |
| Silent Leave | `yumistra.silent-leave` |
| Silent Mentions | `yumistra.silent-mentions` |
| Sticker With Text | `yumistra.sticker-with-text` |
| Custom Welcome | `yumistra.custom-welcome` |
| Multi RPC | `yumistra.multi-rpc` |
| Clean Emoji | `yumistra.clean-emoji` |
| Better Channel List | `yumistra.better-channel-list` |
| Commands | `yumistra.commands` |
| Mini Chat | `yumistra.mini-chat` |
| Voice Overlay | `yumistra.voice-overlay` |
| Better Font Scale | `yumistra.better-font-scale` |
| Server Count | `yumistra.server-count` |
| Show Hidden Channels | `yumistra.show-hidden-channels` |
| Voice Tools | `yumistra.voice-tools` |
| Shizuku Permissions | `yumistra.shizuku-permissions` |

## Discord Watch

A small Android app (`apps/discord-watch`) that catches deleted and edited messages while Discord is closed and hands them to Everything Logger. It connects your account outside Discord (a selfbot) and can get your account banned. The APK is built to the `watch-apk` branch.

## Install

Add this repository in Settings → Valenced → Plugins → [+]:

```
https://yumistra.github.io/Freestyle-Valenced
```

## Build

```sh
npm install
npm run build
npm run package -- --base-url https://yumistra.github.io/Freestyle-Valenced
```

Pushing to `main` builds and deploys to GitHub Pages.
