# Biscord — Profile Update (0.2.1)

A complete, responsive interface for your existing Biscord backend, with editable profiles and more community features. There are no paid feature tiers in this project.

## Update your existing Biscord

1. Stop your old Biscord server with **Ctrl+C**.
2. Make a backup of your old project folder. Keep `biscord.db`, `biscord.db-wal`, and `biscord.db-shm` together if the last two exist. Back up your `uploads` folder too.
3. Copy the contents of this update's `biscord` folder into your existing Biscord folder. Replace the code files when Windows asks.
4. **Keep your existing `.env`, database files, and `uploads` folder.** This ZIP contains no database, account records, uploaded images, or secret keys. Your database is upgraded automatically when the server starts.
5. Open PowerShell in that folder and run:

```powershell
npm.cmd ci
npm.cmd run setup
npm.cmd start
```

6. Open **http://localhost:3000** and log in with your existing account. If you still see an old interface, press **Ctrl+F5**.

`setup` creates a random secret in `.env` only if the file does not already exist. Keep your old JWT_SECRET if you want existing sessions to remain valid. An old default placeholder secret must be replaced.

For a fresh installation, extract the ZIP and follow steps 5–6. An empty database is created on first launch. On Windows you can also double-click **START-BISCORD.bat**.

## Fix an earlier Windows installation failure

If version 0.2.0 failed with `node-gyp`, `find VS`, or `Cannot find module better-sqlite3`:

1. Stop Biscord and close other terminals running this project.
2. Extract this updated ZIP and copy **all the files inside its `biscord` folder** into your existing project folder, replacing old code. Keep your database files, `uploads` and `.env`.
3. Double-click **REPAIR-AND-START.bat**. It reinstalls only the project dependencies, preserves your existing configuration, and starts the server.
4. If it reports that files in `node_modules` are locked, restart Windows, then run the repair launcher again.
5. Open http://localhost:3000 once the server prints that it is running.

No Visual Studio installation is needed for this update. Manual equivalent, from the project folder in Command Prompt:

```bat
if exist node_modules rmdir /s /q node_modules
npm.cmd ci
npm.cmd run setup
npm.cmd start
```

Do not continue to `npm start` if dependency installation fails.

## Requirements

- Node.js **22.13 or later** (Node.js 24 works).
- npm, included with Node.js.
- An internet connection for the initial dependency installation.
- SQLite is supplied by Node.js through `node:sqlite`. This version no longer uses the `better-sqlite3` npm addon, so Visual Studio, Python and C++ build tools are not required for installation. Node.js 24.18.0 is supported.
- Older supported Node releases may print an SQLite experimental warning; it does not prevent startup.

macOS/Linux commands: `npm ci`, `npm run setup`, `npm start`.

## What you can do

| Feature | Where to find it |
| --- | --- |
| Profile cards | Click any member, message author, friend, or your avatar. |
| Display name, bio, pronouns and profile colour | Bottom-left profile settings button → Edit profile. |
| Avatars and banners, including GIFs | Edit profile → Upload image / Upload banner. Up to 8 MB each; no subscription required. |
| Custom status, Online, Idle, Do not disturb, Invisible | Bottom-left status button, or Edit profile. DND suppresses desktop notifications. |
| Live profile preview and updates | Changes preview in the editor. Saving updates other connected clients. |
| Friends, incoming/outgoing requests and blocking | Home → Friends. Enter an exact username to add someone. |
| Direct messages | Friend's message button or a shared server member's profile. |
| Servers, text channels and invitations | Plus in the server rail; server dropdown; channel plus buttons. |
| Voice rooms and one-to-one voice calls | Voice channels, or the call button in a DM. Up to 8 people per room. |
| Replies, edits, deletion and reactions | Hover over a message. On touch screens, actions remain visible beneath the message. |
| Pinned messages | Message menu → Pin; header pin button lists pinned messages. |
| Saved messages | Message bookmark button; Home → Saved messages. Only you see your saved list. |
| Polls | Composer poll button. 2–8 options, one changeable vote per person; the author or admin can end a poll. |
| Search and older messages | Conversation search box; Load older messages. Ctrl/Cmd+K focuses search. |
| Uploads | Composer plus button. Images, GIFs, video/audio, PDF, TXT and ZIP; progress is shown. |
| Mentions, unread indicators and typing | Use `@username`. Updates appear live. |
| Message drafts | Kept separately for each account and channel in this browser. |
| Owner/admin/member permissions | Server owners can promote/demote members; enforced by the server. |
| Timeouts, kicks, bans and reports | Member profile → Moderate; message menu → Report; server menu → Moderation log. |
| Channel topics, slow mode and deletion | Channel settings. |
| Dark/light themes and compact mode | Settings at the bottom of the server rail. |
| Desktop notifications | Settings → Enable. DMs and mentions notify only while the tab is in the background. |
| Phone layout | Navigation opens from the menu button at the top left. |

`Enter` sends a message. `Shift+Enter` adds a line. Formatting supports **bold**, inline `code`, HTTP(S) links and mentions. Chat text is escaped before formatting.

## Configuration

Copy `.env.example` only when you want to configure values manually. `npm run setup` is easier for a new installation.

- `PORT`: default `3000`.
- `JWT_SECRET`: a unique private secret; at least 16 characters, ideally generated by `setup`.
- `MAX_UPLOAD_MB`: ordinary attachment size limit; default `1024`, maximum `1024`. Profile images stay limited to 8 MB. Storage and bandwidth still need to be provided by the host.
- `BISCORD_DATA_DIR`: optional directory for the database and uploaded files. Defaults to the project folder.
- `ICE_SERVERS`: optional JSON array of WebRTC STUN/TURN server settings; see `.env.example`.

## Using it from different houses

Running on `localhost` makes the site available only on that computer. To share it over the internet, host the Node server with a **persistent disk** and **HTTPS**, and proxy WebSocket upgrades for `/ws`. This is a Node application, so uploading only the `public` folder to static hosting will not provide accounts or real-time chat.

Voice is peer-to-peer audio with microphone permission. It requires **localhost or HTTPS**. The default STUN server is not enough for every router/firewall; configure a TURN server for reliable calls across different networks. The UI reports failed connections. This version does not include video calls, screen sharing, an SFU, group DMs, threads, forum/stage channels, bots, email verification, account recovery or 2FA. It is not a full Discord replacement.

Messages are stored in SQLite, not end-to-end encrypted. Uploaded files retain the original project's opaque public download-link design: anyone who obtains a file URL can download that file. Profile uploads are checked for size, allowed extension and image signature; new attachments are bound to their uploader. Original attachments require the original `uploads` folder, which was not included among the supplied files.

## Validation

Run:

```powershell
npm.cmd test
```

All 11 integration tests pass with the built-in Node SQLite implementation. They cover:

- Additive upgrades from the original schema, preserving old records.
- Authentication, duplicate usernames, profile fields, profile visibility and no password exposure.
- Image signature checks and upload ownership.
- Friend requests, DMs, blocking and unblocking.
- Message permissions, replies, editing, reactions and pins.
- Poll voting and closing.
- Private bookmarks and dependent-record cleanup after message deletion.
- Unread counts, mentions, slow mode and timeouts.
- Live profile events and voice membership/kick enforcement.
- Commit/rollback behavior and nested transaction isolation in the Node SQLite adapter.

Tests use temporary databases and never modify your real data.

Browser checks also passed for registration, server/channel creation, profile preview and image upload, saving and reloading profiles, sending and escaping message text, replies, reactions, bookmarks, polls, search, joining/leaving a voice room with a simulated microphone, themes and mobile navigation. No browser script errors were observed. Cross-network voice audio was not validated.

A copy of the supplied database was also upgraded and checked separately for unchanged user, server, membership and message records. The database files supplied by you were not edited.

## Project files

- `server.js`: HTTP API, database migrations, WebSocket events and voice signalling.
- `database.js`: adapter for SQLite included with Node.js; opens your existing SQLite database without conversion.
- `public/index.html`, `public/styles.css`, `public/app.js`: browser interface, profiles, chat and audio calls.
- `setup.js`: creates a local random secret without replacing existing configuration.
- `test/features.test.js`: integration tests.
- `START-BISCORD.bat`: Windows launcher.
- `REPAIR-AND-START.bat`: reinstalls project dependencies and starts Biscord after a failed installation. It removes only `node_modules`, preserving your database, uploads and `.env`.
