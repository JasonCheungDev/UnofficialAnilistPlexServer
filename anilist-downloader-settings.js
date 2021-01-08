module.exports = {
    SHARED: {
        DELAY: 10000, 
    },
    ANI: {
        LISTS: [ "Watching", "APS-Request" ],
        BLACKLISTED_ORIGINS: [ 
            "CN" // by default "CN" is backlisted as it'll generally have no results causing a lot of unnecessary overhead.
        ],
        BLACKLISTED_TITLE_WORDS: [
            "v0" // some groups use v0 to indicate a first pass in subbing, meaning a better version should be released shortly
        ]
    },
    QBT: {
        PORT: 8080,
        USERNAME: "admin",
        PASSWORD: "password",
        DOWNLOAD_LOCATION: "C:/Videos/" // Will create subfolders for each format (currently only Anime + Anime Movies)
    },
    PLEX: {
        EMAIL: "plex@gmail.com",
        PASSWORD: "password",
        LIBRARY_NAME: "LibraryName",    // case sensitive
        MULTIPLE_SERVERS_PRESENT: true  // set to true if you're part of multiple servers
    },
    WEB: {
        TITLE: "[UNOFFICIAL] AniList Plex Media Server"
    }
}
