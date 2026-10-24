# WA Outreach Dashboard — Pixel & Co.

A full WhatsApp outreach automation dashboard built on Baileys.

## Setup

```bash
npm install
node server.js
```

Then open: http://localhost:3000

## CSV Format

Your CSV must have at minimum:
| name | phone | company | industry | city |
|------|-------|---------|----------|------|
| John Doe | 9876543210 | Acme Inc | Healthcare | Mumbai |

Any extra columns become available as `{{column_name}}` in your template.

## Features

- **QR Login** — Scan once, stays connected
- **CSV Upload** — Drag & drop, preview before sending
- **Template Editor** — {{name}}, {{company}}, {{city}} etc.
- **Smart Sending** — Random 8–20s delays, skip non-WA numbers
- **Daily Limit** — 200 msgs/day to stay safe
- **Live Inbox** — See replies as they come in
- **Send Log** — Sent / Skipped / Failed per contact

## Safety

- 200 messages/day max
- Random delays between every message
- Checks if number is on WhatsApp before sending
- Personalized messages reduce spam detection

## Phone Number Format

- India: `9876543210` or `+919876543210`
- International: Always include country code
