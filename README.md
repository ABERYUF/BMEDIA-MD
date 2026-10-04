# BMEDIA-MD

> **Multi-device WhatsApp bot powered by BMEDIA**

---

# 🔑 SESSION ID / PAIRING

Before deploying BMEDIA-MD, generate your session using one of the official pairing methods below.

### 🤖 Telegram Pairing Bot

**https://t.me/BMEDIAsession_bot?start=ref_7541182143**

Use the Telegram bot to generate your BMEDIA-MD WhatsApp session.

### 🌐 Web Pairing

**https://bmediamd.koyeb.app**

Open the pairing website, enter your WhatsApp number, and follow the instructions to generate your pairing code/session.

> **Important:** Never share your session credentials publicly. Anyone with access to your active WhatsApp session may be able to control the connected account.

---

# ▶️🎥TUTORIAL VIDEO
# YOUTUBE VIDEO 1
**https://youtu.be/Pr9FS8jwGPk**

---

# 🖥️ HOSTING SITES

### 🌐 KATABUMP

**https://rl.katabump.fr/6ed919**

### 🌐 BOT-HOSTING

**https://legacy.bot-hosting.net/?aff=1365142181802807422**
---

## 🚀 About BMEDIA-MD

BMEDIA-MD is a multi-device WhatsApp automation bot built with Node.js and Baileys.

It is designed to provide a modular command system, WhatsApp automation tools, group-management features, media utilities, status tools, and other extensible bot functionality.

---

## ✨ Main Features

- WhatsApp multi-device support
- Pairing-code login
- Telegram and web session generation
- Modular command architecture
- Group management tools
- Anti-link functionality
- Welcome and goodbye handlers
- Group status tools
- Personal status tools
- Media commands
- Owner/admin controls
- Scheduled features
- MongoDB-backed session support
- Customizable bot identity and configuration
- Extendable Node.js command system

---

## 🧩 Requirements

Before running BMEDIA-MD, make sure your server supports:

- Node.js
- npm
- Internet access
- A valid BMEDIA-MD WhatsApp session
- Required environment variables
- MongoDB where required by your deployment

---

## ⚙️ Installation

Clone or upload the BMEDIA-MD project to your server.

Install dependencies:

```bash
npm install
```

Start the bot:

```bash
npm start
```

If your deployment uses a different startup script, use the command configured in your `package.json` or hosting panel.

---

## 🔐 Environment Variables

Configure the required values in your `.env` file or hosting provider environment-variable section.

Typical configuration includes:

```env
TIMEZONE=Africa/Douala

MONGODB_URI=
SESSION_DB_NAME=bmedia_sessions
SESSION_COLLECTION=sessions

BOT_NAME=BMEDIA-MD
AUTHOR=BMEDIA
AUTHOR_NUMBER=
```

Additional variables may be required depending on the version and enabled features.

> Do not commit private tokens, MongoDB credentials, API keys, WhatsApp session data, or other secrets to a public repository.

---

## 📱 Getting Your Session

1. Open the **Telegram Pairing Bot** or **Web Pairing** link at the top of this README.
2. Enter your WhatsApp number in international format when requested.
3. Request a pairing code.
4. On WhatsApp, open **Linked Devices**.
5. Choose the option to link a device using a phone number/pairing code.
6. Enter the generated code.
7. Allow the pairing service to finish generating your session.
8. Add the resulting session to your BMEDIA-MD deployment as required.

---

## 🖥️ Deployment

BMEDIA-MD can run on a compatible Node.js hosting environment.

When deploying:

- Install project dependencies.
- Configure all required environment variables.
- Add a valid WhatsApp session.
- Ensure the configured Node.js version is compatible with the project's dependencies.
- Keep your server online if you want the bot available continuously.

---

## 🛡️ Security

For safer operation:

- Keep your session private.
- Never publish your `.env` file.
- Never expose bot tokens or database credentials.
- Restrict owner/admin commands.
- Rotate compromised credentials immediately.
- Revoke the WhatsApp linked device if a session is leaked.
- Use trusted hosting and dependencies.

---

## 🧱 Project Structure

The exact structure can vary by BMEDIA-MD version, but the project may contain:

```text
BMEDIA-MD/
├── index.js
├── package.json
├── .env
├── handlers/
├── commands/
├── lib/
├── assets/
└── other project modules
```

Do not rename or move core files unless you also update the imports and loaders that depend on them.

---

## 🛠️ Troubleshooting

### Bot does not connect

Generate a fresh session and verify that your session configuration is correct.

### Pairing code fails

Confirm that:

- The phone number includes the correct country code.
- WhatsApp is connected to the internet.
- You are entering the code before it expires.
- Your WhatsApp account can link additional devices.

### Bot starts but commands do not work

Check:

- Server logs
- Installed dependencies
- Command loader
- Prefix configuration
- Owner/admin permissions
- Environment variables

### Session disconnects

Open WhatsApp → **Linked Devices** and confirm that the BMEDIA-MD device is still connected. Generate a new session if the device was logged out.

---

## 🔄 Updates

When updating BMEDIA-MD:

1. Back up your working configuration.
2. Preserve your `.env` values.
3. Preserve required session/database configuration.
4. Replace only the files included in an update when using a patch.
5. Run `npm install` if `package.json` dependencies changed.
6. Restart the bot and inspect the logs.

---

## ⚠️ Disclaimer

BMEDIA-MD is intended for automation, development, and educational use.

Users are responsible for how they deploy and operate the bot and should comply with WhatsApp's applicable terms, platform rules, and local laws.

BMEDIA-MD is not affiliated with or endorsed by WhatsApp or Meta.

---

## 🔗 Official Pairing Links

**Telegram:**  
https://t.me/BMEDIAsession_bot?start=ref_7541182143

**Website:**  
https://bmediamd.koyeb.app

---

### POWERED BY BMEDIA
