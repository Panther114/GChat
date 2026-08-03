# Gchat Features

This document tracks all implemented features in the Gchat application. All features listed below are currently implemented and working.

## Authentication & User Management
- [x] User registration with username, email, and password
- [x] Email verification required before accessing GChat (6-digit code sent to email)
- [x] Existing users without an email are prompted to add and verify their email on next login
- [x] Email addresses cannot be changed after verification
- [x] After email is verified, normal login/logout works with username and password only
- [x] User login with bcrypt password hashing (cost factor 12)
- [x] Session management with express-session and SQLite store
- [x] User profile customization (username, icon color, and profile picture)
- [x] Custom profile pictures (upload up to 2MB or use color + initial)
- [x] Account deletion
- [x] Secure session cookies (httpOnly, sameSite, secure in production)
- [x] CSRF protection with double-submit token pattern
- [x] Admin endpoint to view registered users (with ADMIN_SECRET)

## End-to-End Encryption
- [x] AES-256-GCM client-side encryption for all messages
- [x] PBKDF2 key derivation (100,000 iterations, SHA-256)
- [x] Derived key caching — one derivation per (passphrase, group) session; subsequent operations reuse the cached CryptoKey
- [x] Per-group encryption keys stored in localStorage
- [x] Encryption key setup interface
- [x] Automatic encryption/decryption of messages
- [x] Support for encrypted file and image uploads
- [x] Server stores only ciphertext and IV, never plaintext

## Group Chat Management
- [x] Create new groups with custom name and code
- [x] Join existing groups via shareable code
- [x] View list of user's groups
- [x] Group member list display
- [x] Leave group (non-owners)
- [x] Disband group (owner only)
- [x] Rename group (all members can rename)
- [x] Group ownership tracking
- [x] Configurable member permissions (allow_member_clear setting)

## Messaging Features
- [x] Real-time text messaging via Socket.IO
- [x] Message encryption/decryption
- [x] Message timestamps with timezone formatting
- [x] Reply/Quote functionality
- [x] Whisper mode (private messages to selected members)
- [x] Image sharing with auto-compression (max 1200px, 75% JPEG quality)
- [x] File sharing (25GB limit)
- [x] Image viewer modal (click to magnify images)
- [x] Automatic file download for non-image files
- [x] Image MIME type detection (JPEG, PNG, GIF, WebP)
- [x] Message deletion (sender or group owner)
- [x] Message editing (sender only, text and whisper messages; shows "(edited)" badge)
- [x] Clear all messages (owner, or members if allowed)
- [x] Paginated message loading (50 messages per page, max 100)
- [x] Load older messages on scroll (tie-breaking pagination — no skipped/duplicate messages)
- [x] Message size limit enforcement (25GB encrypted content)

## User Interface & Experience
- [x] Modern dark glassmorphism UI
- [x] Gradient message bubbles
- [x] Emoji picker (80 emojis)
- [x] Search messages with client-side highlighting
- [x] Export chat history as TXT file
- [x] Typing indicators
- [x] Online presence indicators
- [x] Delivery receipts
- [x] Unread message counter
- [x] "Scroll to bottom" button with unread badge
- [x] "Jump to first unread" button
- [x] Collapsible sidebar for mobile with toggle button
- [x] Collapsible right panel for mobile with toggle button
- [x] Mobile toggle buttons visible on empty state for easy access
- [x] Mobile-responsive layout
- [x] Page title notifications for new messages when tab not focused
- [x] Native OS notifications (Web Notification API) with click-to-focus — browser and desktop app
- [x] Connection status indicator
- [x] Reconnection banner
- [x] Auto-resizing message input textarea
- [x] Reply preview bar above message input showing "replying to" indicator

## Security & Anti-Spam
- [x] Content Security Policy headers
- [x] HTTP Strict-Transport-Security (HSTS) header in production
- [x] Server-side rate limiting (10 messages per 5 seconds)
- [x] Rate limiting applies to both regular messages and whispers
- [x] Client-side rate limiting
- [x] Repeated message detection (prevents 3+ identical messages)
- [x] Password strength requirements (min 6 characters)
- [x] Username validation (2-32 characters)
- [x] Group code validation (2-32 characters)
- [x] Filename sanitization for uploads
- [x] CSRF token validation for state-changing operations
- [x] Session authentication for Socket.IO connections
- [x] Brute-force login protection (10 failed attempts per IP per 15 minutes)
- [x] Email verification send rate limiting (3 sends per minute per IP)
- [x] Email verification code attempt limiting (5 wrong attempts before requiring a new code)
- [x] Timing-safe comparison for ADMIN_SECRET bearer token
- [x] Profile picture MIME type allowlist (JPEG, PNG, GIF, WebP only — SVG rejected)
- [x] Whisper recipient membership validation (recipients must be group members)

## Group Owner Controls
- [x] Kick members from group
- [x] Disband group
- [x] Clear chat history (or allow members to clear)
- [x] Delete any message in owned groups
- [x] Configure group settings (allow_member_clear)

## Database & Persistence
- [x] SQLite database with better-sqlite3
- [x] WAL mode for better concurrent performance
- [x] Safe database migrations
- [x] Persistent session storage (sessions.db)
- [x] Support for Railway Volumes via DB_PATH env var
- [x] Auto-generated session secret with database persistence (falls back to ephemeral random secret — never a hard-coded value)
- [x] Database schema includes: users, group_chats, group_members, messages, _config
- [x] Account deletion wrapped in a single atomic transaction

## Real-time Features (Socket.IO)
- [x] Real-time message delivery
- [x] Typing indicators (start/stop)
- [x] Online presence tracking
- [x] User join/leave notifications
- [x] Member kicked notifications
- [x] Group disbanded notifications
- [x] Chat cleared notifications
- [x] Message deleted notifications
- [x] Group renamed notifications
- [x] User profile updated notifications
- [x] Presence updates on join/disconnect

## Deployment & Configuration
- [x] Railway.app one-click deployment
- [x] Environment variable configuration (SESSION_SECRET, PORT, DB_PATH, ADMIN_SECRET)
- [x] Auto-detection of production environment
- [x] Node.js version requirement (>=18.0.0)
- [x] Railway.json deployment configuration (with `npm install --omit=dev` to exclude Electron devDependencies)
- [x] Static file serving from /public directory
- [x] Trust proxy configuration for Railway

## Desktop App (Electron primary, Tauri macOS fallback)
- [x] Electron native shell (`electron/main.js`) — window, tray, IPC, updater
- [x] Hosted UI bridge (`electron/preload.js`) — `window.electronAPI` surface
- [x] Memory-oriented Chromium flags (WebGPU off, capped V8 heap, reduced background networking)
- [x] System tray icon with left-click restore/focus and right-click menu
- [x] Hide-to-tray on window close and minimize (app keeps running in background)
- [x] Single-instance lock (second launch focuses existing window)
- [x] Native OS notifications
- [x] Notification focus routes to the relevant group
- [x] Dock/taskbar unread badge via native shell
- [x] Auto-launch at system startup (settings toggle)
- [x] electron-updater via GitHub Releases (`latest.yml` / `latest-mac.yml`)
- [x] Settings → Updates in-app check-for-updates UI (status + install/open release)
- [x] Open external links in the default browser
- [x] Windows NSIS installer with Gchat installer icon
- [x] Universal macOS `.app` / `.dmg` builds (same hosted behavior as Windows)
- [x] Optional Tauri 2 / WKWebView macOS fallback (`src-tauri/`, `build:mac:tauri`)
- [x] Desktop light-sphere mouse hover effect removed (v1.3.7)

## Additional Features
- [x] Audio notification sound (Web Audio API)
- [x] Automatic key refresh on encryption key changes
- [x] Session cleanup on user deletion
- [x] Membership cleanup on group disbanding
- [x] Message history export with encryption status indicators
- [x] Reply preview bar with cancel button
- [x] Whisper recipient picker UI
- [x] Group code display and copy functionality
- [x] User logout functionality
- [x] SVG favicon for both auth and chat pages
- [x] Optimised initial message load using DocumentFragment (single DOM mutation)
