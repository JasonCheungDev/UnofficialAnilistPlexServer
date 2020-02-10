# [Unofficial] AniList Plex Server

Automatically download your AniList watch list and serve on a Plex Media Server!

## Features
- Automatically pull AniList user's watch list
- Automatic qBittorrent torrenting of animes with nyaa
- Auto-inviter for Plex 
- Local web UI to manage users and animes

## Setup

### qBittorrent

qBittorrent is used to torrent animes onto your device (which served via Plex)

1. Install qBittorrent

https://www.qbittorrent.org/

2. Enable RSS view

![Image](https://i.imgur.com/SAcXLNS.png)

3. Open "Option" or "Preferences"

![Image](https://i.imgur.com/lhdqtmK.png)

4. Enable auto fetching and auto downloading

![RSS](https://i.imgur.com/IYWCUVB.png)

5. Turn on Web UI

![Image](https://i.imgur.com/AaedDfp.png)

_Note down the Port, Username, and Password_

### Plex 
Plex is used as a media server to host your videos for yourself and others.

1. Install Plex Media Server

https://www.plex.tv/en-ca/

2. Login to plex.tv and note down your username, password, and library name

### Web UI
The web UI is a way to add AniList users and automatically fetch their watch list periodically. 

1. Ensure node.js is installed
https://nodejs.org/en/

2. Write down your qBittorrent and Plex information in `anilist-downloader-settings.js`

2. Open a terminal at the project root

3. Run `npm install`

4. Start the web server with `node app.js`

5. Navigte to the web UI by entering `localhost:3000/` in your browser.
