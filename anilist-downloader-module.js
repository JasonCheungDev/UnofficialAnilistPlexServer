// node::require() is a method to load modules 
const { graphql, buildSchema } = require('graphql')
const fetch = require('node-fetch')
const util = require('util') // https://stackoverflow.com/questions/10729276/how-can-i-get-the-full-object-in-node-jss-console-log-rather-than-object
const sanitize = require('sanitize-filename')
const fs = require('fs')
const Parser = require('rss-parser')
const { si, pantsu } = require('nyaapi')
const res = require('express/lib/response')
const settings = require('./anilist-downloader-settings.js')

// UTIL
function logi(message) {
    console.log(CONSTANTS.CONSOLE.PREFIX + message)
}

function logw(message) {
    console.log(CONSTANTS.CONSOLE.YELLOW + CONSTANTS.CONSOLE.PREFIX + message + CONSTANTS.CONSOLE.RESET)
}

function loge(message) {
    console.log(CONSTANTS.CONSOLE.RED + CONSTANTS.CONSOLE.PREFIX + message + CONSTANTS.CONSOLE.RESET)
}

function dump(object) {
    console.log(util.inspect(object, false, null, true))
}

function nthIndex(str, pat, n) {
    const L = str.length
    let i = -1;
    while (n-- && i++ < L) {
        i = str.indexOf(pat, i);
        if (i < 0) break;
    }
    return i;
}

function now() {
    let date_ob = new Date()

    // current date
    // adjust 0 before single digit date
    let date = ("0" + date_ob.getDate()).slice(-2);

    // current month
    let month = ("0" + (date_ob.getMonth() + 1)).slice(-2);

    // current hours
    let hours = date_ob.getHours();

    // current minutes
    let minutes = date_ob.getMinutes();

    var old = `${month}-${date} ${hours}:${minutes}`

    return date_ob.toLocaleString('en-US', {
        day: 'numeric',
        month: 'short',
        hour: 'numeric',
        minute: 'numeric',
        hour12: true
    })
}

function sleep(ms) {
    return new Promise((resolve) => {
        setTimeout(resolve, ms)
    })
}

// CONSTANTS
const CONSTANTS = {
    FORMAT: {
        TV: "TV",
        MOVIE: "MOVIE",
        OVA: "OVA"
    },
    STATUS: {
        CURRENT: 0,
        PLANNING: 1,
        COMPLETED: 2,
        DROPPED: 3,
        PAUSED: 4,
        REPEATING: 5
    },
    QUALITY_PREFERENCE: [
        "BD",
        "1080",
        "720"
    ],
    GROUPS: {
        HORRIBLE_SUBS: "HorribleSubs"
    },
    STORAGE: {
        DIRECTORY: "./data/",
        FILENAME: "anidownloader.data.json",
        BACKUP_FILENAME: "anidownloader.backup.data.json"
    },
    CONSOLE: {
        PREFIX: "[aniDownloader]:",
        RESET: "\x1b[0m",
        RED: "\x1b[31m",
        YELLOW: "\x1b[33m"
    },
    MISC: {
        strict: true
    }
}

class AnimeInfo {
    constructor(id, name, format) {
        if (id === undefined || id === 0) {
            loge("Attempting to make an AnimeInfo with no ID!")
        }
        // AniList Data
        this.mediaId = id       // anilist ID
        this.format = format    // format (tv,movie,ova) - only special handling for movie
        this.title = name       // title
        this.startDate = null   // when the first episode is airing. will be null if the specific day is TBA.
        // Internal Data
        this.isSetup = false    // successfully went thru all auto-download procedures
        this.noResults = false  // failed to find any results
        this.isBlacklisted = false// blacklisted (will not download)
        this.manual = ""        // manual title to search for
        this.downloadTime = null// if set indicates when this anime will be downloaded
        this.observe = ""       // if set indicates the torrent name filter used to check for stalled downloads in the torrent client
        this.isStalled = false  // torrenting may be stalled (no seeders)
    }

    // note: static functions as data is reloaded as a plain object (without this prototype)

    static isStartDateConfirmed(animeInfo) {
        return (animeInfo.startDate
            && animeInfo.startDate.day != null
            && animeInfo.startDate.month != null
            && animeInfo.startDate.year != null)
    }

    static isAllDataLoaded(animeInfo) {
        return (animeInfo.format && animeInfo.title && AnimeInfo.isStartDateConfirmed(animeInfo))
    }
}

class UserInfo {
    constructor(name) {
        this.username = name
        this.lastUpdated = now()
    }
}

class FeedEntry {
    constructor(link, group, originalTitle, title, episode, quality, isBatch, seeders) {
        this.link = link
        this.originalTitle = originalTitle
        this.group = group
        this.title = title
        this.episode = parseInt(episode)
        this.quality = quality
        this.isBatch = isBatch
        this.seeders = seeders
    }
}

class Worker {
    constructor(name, interval) {
        this.name = name
        this.interval = interval
        this.jobs = []
        this.timer = null
    }

    addJob(jobCallback) {
        this.jobs.push(jobCallback)
        if (this.jobs.length == 1 && !this.isWorking()) {
            console.log(`Worker ${this.name} : Started!`)
            const worker = this
            this.timer = setTimeout(() => { worker._executeNextJob() }, 0)
        }
    }

    isWorking() {
        return this.timer != null
    }

    // TODO: Preferably this would wait for the job to actually finish (if async)
    _executeNextJob() {
        console.log(`Executing next job for worker ${this.name}. Count: ${this.jobs.length}`)

        const callback = this.jobs.shift()
        callback()

        if (this.jobs.length > 0) {
            const worker = this
            setTimeout(() => { worker._executeNextJob() }, worker.interval)
        } else {
            console.log(`Worker ${this.name} : All jobs finished!`)
            this.timer = null
        }
    }
}

// RUNTIME + SERIALIZED DATA
var globals = {
    aniDownloader: {
        animes: [],
        users: [],
        lastUpdated: Date.now(),
        lastUpdatedPretty: ""
    }
}

const workers = {
    ani: new Worker("AniWorker", settings.SHARED.DELAY),
    nyaa: new Worker("NyaaWorker", settings.SHARED.DELAY)
}

// APPLICATION
var shared = {
    markAnimeSetup: function (title) {
        var element = globals.aniDownloader.animes.find(animeInfo => {
            return animeInfo.title == title;
        })

        if (element) {
            logi(`[UPDATE] ${title} is setup`)
            element.isSetup = true
            element.noResults = false
            element.isStalled = false
        } else {
            logw(`Could not mark cached anime as setup - could not find the anime ${title}`)
        }
    }
}

// TORRENT TRACKER API
var trackers = {
    common: {
        /**
         * Retrieves the strict anime title (for rules) from a tracker listing. This is the actual title found in a RSS query.
         * @param {String} title The tracker listing title (eg. "[TranslatorGroup] title - 12")
         */
        parseStrictTitleFromFeedEntry: function (entry) {
            /* explanation: 
                "]\s+"          : find the end of the translator group "[Horrible Subs] "
                .+?             : match everything until...
                (?=\s+-\s+\d\d) : find the episode description " - S02" or " - 12"
                return ...      : strip out the episode number
               alternatively:
                \]\s+(.+?)(?:\s+-\s+S?\d\d)\ will capture just the title.
            */
            var regexPattern = /]\s+.+?(?:\s+-\s+S?\d\d)/
            var match = entry.match(regexPattern)
            if (!match) return null
            return match[0].substr(0, match[0].lastIndexOf('-') + 1)
        },

        /**
         * Find the closest title to the original in a given RSS feed result.
         * 
         * @param {String} originalTitle The original title (from AniList)
         * @param {FeedEntry} feedResults The list of RSS feed entries
         * @example Original: "Another" finds ["Another", "ImoCho - Another Shitty Sister Manga Adaptation"] returning "Another" for best match
         */
        generateStrictTitleFromFeedResults: function (originalTitle, feedResults) {
            logi(`Generating strict title for ${originalTitle}`)

            // find all unique titles
            var titles = new Set();
            feedResults.forEach(item => {
                var strictTitle = this.parseStrictTitleFromFeedEntry(item.title)
                if (strictTitle) {
                    titles.add(strictTitle)
                }
            });

            if (titles.size == 0) {
                logw("No results detected from RSS query.")
                return ""
            } else {
                logi("Found unique titles:")
                dump(titles)
            }

            // find best match 
            function simpleEvaluator(original, toCheck) {
                return Math.abs(original.length - toCheck.length)
            }

            var bestTitle = ""
            var errorRating = Infinity
            titles.forEach(item => {
                const error = simpleEvaluator(originalTitle, item)
                if (error < errorRating) {
                    bestTitle = item
                    errorRating = error
                }
            })

            logi(`Best title: ${bestTitle}`)

            return bestTitle
        },

        /**
         * Retrieves the group, title, episode, and quality of an RSS entry
         * @param {String} entry 
         */
        parseInfoFromFeedEntry: function (link, entry, seeders) {
            logi(`Parsing info from feed entry - ${entry}`)

            // Standard Match
            const regexPattern = /\[(.+?)\]\s+(.+?)\s+-\s+(?:S\d\dE)?(\d\d)\s+[\[\(](.+?)[\]\)]/i
            const match = entry.match(regexPattern)
            if (match) {
                return new FeedEntry(link, match[1], entry, match[2], match[3], this.parseQualityFromString(match[4]), false, seeders)
            }

            // Extrapolate Match (batch assumed)
            const groupRegexPattern = /^\[(.+?)\]/
            const groupMatch = entry.match(groupRegexPattern)
            const group = groupMatch ? groupMatch[1] : ""
            const title = this.cleanTitleFromEntry(entry)
            const quality = this.parseQualityFromString(entry)
            return new FeedEntry(link, group, entry, title, -1, quality, true, seeders)
        },

        parseQualityFromString: function (string) {
            var quality = 0

            if (string.includes("BD") || string.includes("BluRay")) {
                quality += 10000 // Bluray modifier is always preferred
            }

            if (string.includes("1080")) {
                quality += 1080
            } else if (string.includes("720")) {
                quality += 720
            } else if (string.includes("480")) {
                quality += 480
            }

            return quality
        },

        cleanTitleFromEntry: function (string) {
            return string.replace(/_/g, " ")
                .replace(/\(.+?\)/g, "")
                .replace(/\[.+?\]/g, "")
                .replace(/batch/gi, "")
                .replace(/\d\d-\d\d/g, "")
                .replace(/\..{3}$/, "")
                .trim()
        },

        /**
         * The default subbing group evaluation for entry comparison 
         * if the group wasn't explicitly defined in preferences.
         * Lazily initialized when required.
         */
        defaultGroupEvaluation: null,

        /**
         * Finds the best entry given results.
         * 
         * @param {String} originalTitle The original title (from AniList)
         * @param {FeedEntry} feedResults The list of RSS feed entries
         * @example Original: "Another" finds ["Another", "ImoCho - Another Shitty Sister Manga Adaptation"] returning "Another" for best match
         */
        getBestFeedEntry: function (originalTitle, feedResults) {
            logi(`Finding best entry for ${originalTitle}`)
            dump(feedResults)

            if (feedResults.length == 0) {
                logi("No feed results")
                return null
            }

            // parse all entries 
            var entries = new Array()
            feedResults.forEach(item => {
                var entry = this.parseInfoFromFeedEntry(item.link, item.title, item.seeders)
                if (!entry)
                    return
                entries.push(entry)
            });

            if (entries.size == 0) {
                logw("No results detected from RSS query.")
                return null
            }

            // title evaluator
            function titleEvaluator(originalTitle, entryToCheck) {
                const lowerCaseTitle = originalTitle.toLowerCase()
                const entryTitle = entryToCheck.title.toLowerCase()

                let error = Math.abs(lowerCaseTitle.length - entryTitle.length)
                if (error == 0) {
                    // lengths are exact, check each character (useful for seasons)
                    for (let i = 0; i < lowerCaseTitle; i++) {
                        if (originalTitle.charAt(i) != entryTitle.charAt(i)) {
                            error += 1 / lowerCaseTitle
                        }
                    }
                }
                return error
            }

            // subbing group evaluator
            function getGroupEvaluator(group) {
                for (let i = 0; i < settings.QBT.GROUP_PREFERENCE; i++) {
                    if (group == settings.QBT.GROUP_PREFERENCE[i]) {
                        return i
                    }
                }

                // use default group evaluation
                if (trackers.common.defaultGroupEvaluation === null) {
                    for (let i = 0; i < settings.QBT.GROUP_PREFERENCE; i++) {
                        if (group == "ANY") {
                            trackers.common.defaultGroupEvaluation = 1
                        }
                    }
                }
                return trackers.common.defaultGroupEvaluation
            }

            function entryComparator(lhs, rhs) {
                // subbing group preference
                const lGroup = getGroupEvaluator(lhs.group)
                const rGroup = getGroupEvaluator(rhs.group)
                if (lGroup != rGroup) {
                    return lGroup - rGroup
                }

                // best title
                const l = titleEvaluator(originalTitle, lhs)
                const r = titleEvaluator(originalTitle, rhs)
                if (l != r) {
                    return l - r
                }

                // best quality
                if (lhs.quality != rhs.quality) {
                    return rhs.quality - lhs.quality
                }

                // batch preferred
                if (lhs.isBatch != rhs.isBatch) {
                    return lhs.isBatch ? -1 : 1
                }

                // seeders preferred
                if (lhs.seeders != rhs.seeders) {
                    return rhs.seeders - lhs.seeders
                }

                // all checks equal, no difference
                return 0
            }

            entries.sort(entryComparator)

            let bestEntry = entries[0]
            logi(`Best entry: ${bestEntry.title} is batch ${bestEntry.isBatch} for title ${originalTitle}`)
            dump(bestEntry)
            return bestEntry
        }
    },
    nyaa: {
        generateRssFeedUrl: function (title, quality, group, makeStrict) {
            // c=1_2 == Anime - English Translated
            if (makeStrict) {
                title = `"${title}"`
            }
            var uriFriendlyString = "https://nyaa.si/?page=rss&q=" + encodeURIComponent(group + " " + title + " " + quality) + "&c=1_2&f=0"
            logi(`nya.generateRssFeedUrl: ${uriFriendlyString}`)
            return uriFriendlyString
        },

        getRssFeedResults: async function (feedUrl) {
            logw("====FEED URL")
            dump(feedUrl)
            let parser = new Parser({
                customFields: {
                    item: [
                        ["nyaa:seeders", "seeders"]
                    ]
                }
            });
            let results = await parser.parseURL(feedUrl)
            return results.items
        },

        getSearchResults: async function (search) {
            const maximumResults = 75
            let results = await si.search(search, maximumResults, {
                category: '1_2',
                sort: 'seeders',
                p: 1
            })
            // reformat to rss standard (this allows us reuse getBestFeedEntry)
            results = results.map(result => {
                const rssStandard = {
                    title: result.name,
                    link: result.torrent,
                    seeders: result.seeders
                }
                return rssStandard
            })
            return results
        }
    }
}

// TORRENT CLIENT API
var qbt = {
    getUrl: function () {
        return 'http://localhost:' + settings.QBT.PORT
    },
    handleResponse: function (response) {
        // dump(response)
    },
    authenticate: async function () {
        const apiUri = "/api/v2/auth/login?"

        const queryString = new URLSearchParams({
            username: settings.QBT.USERNAME,
            password: settings.QBT.PASSWORD
        })

        const response = await fetch(this.getUrl() + apiUri + queryString.toString(), {
            method: 'GET'
        })

        if (response.status == 200) {
            // if successful, authentication information will be stored (not directly accessible in JS anymore)
            logi("successful login")
            // example: SID=UvanerY1qZdKhnH64EZJbSbkNnqX14Yz; HttpOnly; path=/; SameSite=Strict
            const cookie = response.headers.get('set-cookie')
            // example: SID=UvanerY1qZdKhnH64EZJbSbkNnqX14Yz
            const SID = cookie.substr(0, cookie.indexOf(';'))
            return SID
        } else {
            loge("FAILED login")
            return null
        }
    },
    /**
     * 
     * @param {string} errorMessage : Custom error message. Optional.
     * @param {string} method : REST method. 'GET' by default.
     */
    authenticateAndGenerateFetchOptions: async function (errorMessage, method) {
        if (!errorMessage) errorMessage = ""
        if (!method) method = "GET"

        const SID = await this.authenticate()
        if (!SID) {
            loge(`FAILED to login to qbt. ` + errorMessage)
            return null
        }

        const options = {
            method: method, // WARNING: MOST REQUESTS MUST BE GET (despite the docs)
            headers: {
                'Cookie': SID
            }
        }

        return options
    },
    getSavePath: function (animeInfo) {
        const directory = settings.QBT.DOWNLOAD_LOCATION + (animeInfo.format == CONSTANTS.FORMAT.MOVIE ? "Anime Movie/" : "Anime/")
        const safePath = sanitize(animeInfo.title)
        return directory + safePath
    },
    addFeed: async function (feed, title) {
        logi(`[QBT] Adding feed ${feed}`)

        // check if necessary
        var element = globals.aniDownloader.animes.find(animeInfo => {
            return animeInfo.title == title;
        })

        if (element && element.isSetup) {
            logi(`qbt ${title} is already setup - skipping`)
            return;
        }

        // remove first if necessary
        logi("Attempting to remove existing feed first")
        await this.removeFeed(title)

        // setup request
        const apiUri = '/api/v2/rss/addFeed?'

        const options = await this.authenticateAndGenerateFetchOptions(`addFeed for ${title}`)

        const safePath = sanitize(title)

        const queryString = new URLSearchParams({
            url: feed,
            path: safePath
        })

        const response = await fetch(this.getUrl() + apiUri + queryString, options)

        if (!response.ok) {
            loge("FAILED TO ADD RSS FEED TO QBT:\n" + util.inspect(response, false, null, true))
        }
    },
    removeFeed: async function (title) {
        // setup request
        const apiUri = '/api/v2/rss/removeItem?'

        const options = await this.authenticateAndGenerateFetchOptions(`removeFeed for ${title}`)

        const safePath = sanitize(title)

        const queryString = new URLSearchParams({
            path: safePath
        })

        const response = await fetch(this.getUrl() + apiUri + queryString, options)

        if (!response.ok) {
            logi(`Failed to remove RSS feed title ${title} - this is normal for initial setup.`)
        }
    },
    /**
     * Adds an auto-download rule for an RSS feed. Without an auto-download rule nothing from a feed will be downloaded.
     * 
     * @param {*} feed The RSS feed URL.
     * @param {*} title The title of the anime.
     * @param {*} animeInfo The AnimeInfo object for tracking.
     * @param {*} strictMatchRule A filter string that a feed entry title must have. If not defined everything in the feed will be downloaded.
     */
    addRule: async function (feed, title, animeInfo, strictMatchRule) {
        logi(`[QBT] Adding rule ${title}`)

        const apiUri = '/api/v2/rss/setRule?'

        const options = await this.authenticateAndGenerateFetchOptions(`addRule for ${title}`)

        const additionalIgnoreRules = []
        if (strictMatchRule) {
            // In general when a strictMatchRule is set we want to ignore any batch results (the batch flow handles that).
            additionalIgnoreRules.push("batch")
        }
        // TODO: May want filter out blacklisted words if its contained in the strict match rule. (nothing will download)
        const ignore = settings.ANI.BLACKLISTED_TITLE_WORDS.concat(additionalIgnoreRules).join("|")

        const downloadRule = {
            "enabled": true,
            "mustContain": strictMatchRule ? strictMatchRule.replace(/\(/g, "\\(").replace(/\)/g, "\\)") : "", // escape brackets if detected
            "mustNotContain": ignore,
            "useRegex": strictMatchRule ? true : false,
            "episodeFilter": "",
            "smartFilter": false,
            "previouslyMatchedEpisodes": [],
            "affectedFeeds": [
                feed
            ],
            "ignoreDays": 0,
            "lastMatch": "",
            "addPaused": false,
            "assignedCategory": "Anime",
            "savePath": this.getSavePath(animeInfo)
        }

        const queryString = new URLSearchParams({
            ruleName: title,
            ruleDef: JSON.stringify(downloadRule)
        })

        const response = await fetch(this.getUrl() + apiUri + queryString, options)

        if (response.status == 409) {
            logi("RSS RULE ALREADY EXISTS")
            // don't return, need to mark
        } else if (!response.ok) {
            loge("FAILED TO ADD RSS RULE TO QBT:\n" + dump(response))
            return;
        }

        // track
        shared.markAnimeSetup(title)
    },
    queryTorrents: function () {
        /*
        // var SID = await this.authenticate()

        this.authenticate()
            .then(onAuthenticate);

        function onAuthenticate(SID) {

            logi("onAuthenticate " + SID)

            var apiUri = '/api/v2/torrents/info'
            
            //var apiUri = 'api/v2/rss/addFeed?'

            var queryString = new URLSearchParams({
                url: "TestURL", //feed
                path: "Test3Folder"
            })

            const options = {
                method: 'POST',
                headers: {
                    'Cookie': SID,
                    'Content-Type': 'application/json',
                    'Accept': 'application/json'
                    //SID: SID.substr(4, SID.length - 4)
                },
                
            }

            // logi(options)

            // const response = await fetch(this.getUrl() + apiUri, options)

            logi("FETCH " + 'http://localhost:' + settings.QBT.PORT + apiUri)

            fetch('http://localhost:' + settings.QBT.PORT + apiUri, options)
                .then(hr)
                .then(hd)
                .catch(err => logi(err))

            function hr(response) {
                dump(response)
                logi("RESPONSE")
                return response.json().then(function (json) {
                    return response.ok ? json : Promise.reject(json);
                });
            };

            function hd(data){
                logi("DATA")
                dump(data);
            }
        }

        dump(response)
        */
    },
    addTorrent: async function (title, animeInfo, torrentUrl) {
        logi(`[QBT] Adding torrent: ${torrentUrl} for title: ${title}`)

        const apiUri = '/api/v2/torrents/add?'

        const options = await this.authenticateAndGenerateFetchOptions(`addTorrent for ${title}`)

        const queryString = new URLSearchParams({
            urls: torrentUrl,
            savepath: this.getSavePath(animeInfo),
            category: "Anime"
        })

        const response = await fetch(this.getUrl() + apiUri + queryString, options)

        if (response.status == 415) {
            loge("Torrent file is not valid.")
            return
        } else if (!response.ok) {
            loge("FAILED TO ADD TORRENT TO QBT:\n" + dump(response))
            return
        }

        // track
        shared.markAnimeSetup(title)
    },
    checkForStalledTorrents: async function () {
        logi(`[QBT] Querying all stalled torrents`)

        const apiUri = '/api/v2/torrents/info?'

        const options = await this.authenticateAndGenerateFetchOptions(`checkForStalledTorrents`)

        const queryString = new URLSearchParams({
            filter: 'stalled_downloading'
        })

        const response = await fetch(this.getUrl() + apiUri + queryString, options)

        if (!response.ok) {
            loge("FAILED to checkForStalledTorrents.\n" + dump(response))
            return
        }

        const torrents = await response.json()

        if (torrents.length == 0) {
            logi(`[QBT] No torrents stalled!`) // verbose
            return
        }

        for (const animeInfo of globals.aniDownloader.animes) {
            if (!animeInfo.observe || animeInfo.isStalled) {
                continue
            }

            for (const torrentEntry of torrents) {
                if (torrentEntry.name.includes(animeInfo.observe)) {
                    logw(`[QBT] Possible stalled anime for title: ${animeInfo.title}`)
                    animeInfo.isStalled = true
                    break
                }
            }
        }
    }
}

// ANILIST API
var anilist = {
    // QUERIES 

    // Here we define our query as a multi-line string
    // Storing it in a separate .graphql/.gql file is also possible
    queryAnime: `
query ($id: Int) { # Define which variables will be used in the query (id)
    Media (id: $id, type: ANIME) { # Insert our variables into the query arguments (id) (type: ANIME is hard-coded in the query)
        id
        format
        title {
            romaji
            english
            native
        }
        countryOfOrigin
        startDate {
            year
            month
            day
        }
    }
}`,

    queryUser: `
query ($name: String) {
    User (name: $name) {
        id
        name
        favourites {
            anime {
                nodes {
                    title {
                        romaji
                        english
                    }
                }
            }
        }
        statistics {
            anime {
                count
                meanScore
                minutesWatched
                episodesWatched
                statuses {
                    count
                    mediaIds
                    status
                }
            }
        }
        mediaListOptions {
            animeList {
                sectionOrder
                customLists
                advancedScoring
            }
        }
        siteUrl
    }
}`,

    queryMediaListCollection: `
query ($name: String) {
    MediaListCollection(userName: $name, type: ANIME) {
        lists {
            name
            entries {
                id
                mediaId
            }
        }
    }
}`,

    queryMediaList: `
query {
    MediaList(id: 89369849) {
        id
        userId
        mediaId
    }
}`,

    // Define our query variables and values that will be used in the query request
    generateQueryVariables: function (username) {
        return {
            name: username
        }
    },

    // COMMON

    generateRequest: function (query, variables) {
        // Define the config we'll need for our Api request
        var ret = {
            url: 'https://graphql.anilist.co',
            options: {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Accept': 'application/json',
                },
                body: JSON.stringify({
                    query: query,
                    variables: variables
                })
            }
        };
        return ret;
    },

    handleJsonResponse: function (response) {
        return response.json().then(function (json) {
            return response.ok ? json : Promise.reject(json);
        });
    },

    // QUERY SPECIFIC

    handleUserListdata: async function (data) {
        logi("handleUserListdata");

        var i = 0
        for (const MediaListGroup of data.data.MediaListCollection.lists) {

            // list name check
            if (!settings.ANI.LISTS.includes(MediaListGroup.name)) {
                continue
            }

            for (const MediaList of MediaListGroup.entries) {
                var mediaId = MediaList.mediaId;

                // retrieve existing data 
                var animeInfo = globals.aniDownloader.animes.find(element => {
                    return element.mediaId == mediaId;
                })

                // new entry check
                if (!animeInfo) {
                    logi(`New anime detected. Media ID: ${mediaId}`)
                    animeInfo = new AnimeInfo(mediaId)
                    globals.aniDownloader.animes.push(animeInfo)
                }
            }
        }
    },

    handleError: function (error) {
        loge("Error detected")
        dump(error)
    },

    handleMediaData: async function (data) {
        logi(`Retrieved media info for ${data.data.Media.id}. Title:`)
        dump(data.data.Media.title)

        // track data 
        var mediaId = data.data.Media.id
        var title = data.data.Media.title.romaji
        var format = data.data.Media.format
        var country = data.data.Media.countryOfOrigin
        var startDate = data.data.Media.startDate
        var animeInfo = globals.aniDownloader.animes.find(element => {
            return element.mediaId == mediaId
        })

        // new entry - create
        if (!animeInfo) {
            animeInfo = new AnimeInfo(mediaId, title, format)
            globals.aniDownloader.animes.push(animeInfo)
        }

        // fill in data that can be missing
        animeInfo.title = title
        animeInfo.format = format
        animeInfo.startDate = startDate

        // blacklist check
        if (settings.ANI.BLACKLISTED_ORIGINS.includes(country)) {
            animeInfo.isBlacklisted = true
            animeInfo.isSetup = true
            logi(`${title} is blacklisted - will not download`)
        }

        // pass it off to nyaa if need be
        logi(`Job: Scanning if media: ${animeInfo.title} requires auto-downloading`)
        if (!animeInfo.isSetup && AnimeInfo.isAllDataLoaded(animeInfo)) {
            logi(`Requesting auto-downloading job for ${animeInfo.title}`)

            workers.nyaa.addJob(() => {
                logi(`Job: Setting up auto-downloading for ${animeInfo.title}`)
                anilist.trySetupAutoDownloading(animeInfo)
            })
        }
    },

    trySetupAutoDownloading: async function (animeInfo) {
        const title = animeInfo.title
        logi(`trySetupAutoDownloading for ${title}`)

        // setup check
        if (animeInfo.isSetup) {
            logi(`${title} is already setup - skipping setting up auto-downloading`)
            return
        }

        // airing check
        const startTimestamp = new Date(animeInfo.startDate.year, animeInfo.startDate.month - 1, animeInfo.startDate.day - 1)
        const downloadTime = startTimestamp.getTime() + settings.ANI.REQUIRED_AIRING_DURATION
        const nowTime = new Date().getTime()
        if (nowTime < downloadTime) {
            logi(`${title} has not aired long enough - skipping setting up auto-downloading`)
            animeInfo.downloadTime = downloadTime // view info
            return
        } else {
            animeInfo.downloadTime = null         // view info
        }

        // update rules 
        if (animeInfo.manual) {
            // manual mode set (while strict is set to false, the manual rule might include strict rules itself)
            let feed = trackers.nyaa.generateRssFeedUrl(animeInfo.manual, "", "", false)
            await qbt.addFeed(feed, title)
            await qbt.addRule(feed, title, animeInfo)
            animeInfo.observe = animeInfo.manual
        } else if (CONSTANTS.MISC.strict) {
            // update feed 
            const relaxedTitle = title.replace(/[^a-zA-Z\d\s]/g, " ")
            const results = await trackers.nyaa.getSearchResults(relaxedTitle)
            const bestEntry = trackers.common.getBestFeedEntry(title, results)

            if (bestEntry) {
                if (bestEntry.isBatch) {
                    await qbt.addTorrent(title, animeInfo, bestEntry.link)
                    animeInfo.observe = bestEntry.title
                } else {
                    let bestFeed = trackers.nyaa.generateRssFeedUrl(bestEntry.title, bestEntry.quality, bestEntry.group, true)
                    await qbt.addFeed(bestFeed, title)
                    await qbt.addRule(bestFeed, title, animeInfo, `\] ${bestEntry.title} -`)
                    animeInfo.observe = bestEntry.title
                }

                if (bestEntry.seeders == 0) {
                    logw("Best Entry has no seeders - download may stall!")
                }
            } else {
                // no results - failed
                animeInfo.noResults = true
                logw(`Unable to find any results for ${title} - marking as failed`)
            }
        } else {
            // update feed (no checks - just add)
            let feed = trackers.nyaa.generateRssFeedUrl(title, "1080", CONSTANTS.GROUPS.HORRIBLE_SUBS)
            await qbt.addFeed(feed, title)
            await qbt.addRule(feed, title, animeInfo)
            animeInfo.observe = title
        }
    }
}

// Add a user
function addUser(name) {
    logi(`Adding user ${name}`)

    dump(globals)

    var result = globals.aniDownloader.users.find(userInfo => {
        return userInfo.username == name
    })

    if (result) {
        logi("User is already added - ignoring.")
        return
    }

    globals.aniDownloader.users.push(new UserInfo(name))

    updateAll()
}

function removeUser(name) {
    logi(`Removing user ${name}`)

    globals.aniDownloader.users = globals.aniDownloader.users.filter(userInfo => {
        return userInfo.username != name
    });
}

function setManualRule(mediaId, rule) {
    logi(`Adding manual rule for ${mediaId} with rule ${rule}`)

    let animeInfo = globals.aniDownloader.animes.find(anime => {
        return anime.mediaId == mediaId
    })

    if (!animeInfo) {
        loge(`Unable to add manual rule, could not find anime!`)
        return
    }

    animeInfo.manual = rule
    animeInfo.isSetup = false
    animeInfo.noResults = false
}

async function addManualDownload(mediaId, link) {
    logi(`Adding manual download for ${mediaId} with link ${link}`)

    let animeInfo = globals.aniDownloader.animes.find(anime => {
        return anime.mediaId == mediaId
    })

    if (!animeInfo) {
        loge(`Unable to add manual rule, could not find anime!`)
        return
    }

    await qbt.addTorrent(animeInfo.title, animeInfo, link)
    // don't observe, we assume if a manual link is given then it's good
    animeInfo.observe = ""
}

function resetAnime(mediaId) {
    logi(`Resetting anime for ${mediaId} to default state.`)

    let animeInfo = globals.aniDownloader.animes.find(anime => {
        return anime.mediaId == mediaId
    })

    if (!animeInfo) {
        loge(`Unable to reset, could not find anime!`)
        return
    }

    animeInfo.isSetup = false
    animeInfo.noResults = false
    animeInfo.manual = ""
    animeInfo.observe = ""
    animeInfo.isStalled = false
}

function resolveAnime(mediaId) {
    logi(`Force resolving anime for ${mediaId}.`)

    let animeInfo = globals.aniDownloader.animes.find(anime => {
        return anime.mediaId == mediaId
    })

    if (!animeInfo) {
        loge(`Unable to resolve, could not find anime!`)
        return
    }

    animeInfo.isSetup = true // don't auto-download until user input
    animeInfo.noResults = true // this enables the resolution tool
    animeInfo.manual = ""
    animeInfo.observe = ""
    animeInfo.isStalled = false
}

async function getResolutionEntries(animeInfo) {
    logi(`getResolutionEntries ${animeInfo.title}`)
    let relaxedTitle = animeInfo.title
    // remove special characters
    relaxedTitle = relaxedTitle.replace(/[^a-zA-Z\d\s]/g, " ")
    // only use up to first 3 words
    const idx = nthIndex(relaxedTitle, " ", 3)
    if (idx > 0) {
        relaxedTitle = relaxedTitle.substr(0, idx)
    }

    let results = await trackers.nyaa.getSearchResults(relaxedTitle)
    // don't allow 0 seeders to stall again
    results = results.filter((result) => {
        return result.seeders > 0
    })

    return {
        searchTerm: relaxedTitle,
        results: results
    }
}

// Checks all AniList users and downloads all anime in the "Watching" list.
function updateAll() {
    logi("Module updating all")

    if (isWorkActive()) {
        logw("Work is already active - skipping updateAll()")
        return
    }

    globals.aniDownloader.users.forEach((userInfo, index, array) => {

        // Phase 1. Querying all user lists
        workers.ani.addJob(() => {
            logi(`Job: Retrieving user list for ${userInfo.username}`)

            userInfo.lastUpdated = now()

            var request = anilist.generateRequest(anilist.queryMediaListCollection, { name: userInfo.username });

            // Make the HTTP Api request
            fetch(request.url, request.options)
                .then(anilist.handleJsonResponse)
                .then(anilist.handleUserListdata)
                .catch(anilist.handleError);
        })

    })

    // Phase 2. Retrieving anime data
    workers.ani.addJob(() => {
        logi(`Job: Scanning for media missing info`)

        for (const animeInfo of globals.aniDownloader.animes) {
            if (!AnimeInfo.isAllDataLoaded(animeInfo)) {
                const mediaId = animeInfo.mediaId
                logi(`aniApi: ${mediaId} missing data - retrieving`)

                workers.ani.addJob(() => {
                    logi(`Job: Retrieving media data for ${mediaId}`)

                    var iVar = {
                        id: mediaId
                    }

                    var iReq = anilist.generateRequest(anilist.queryAnime, iVar)

                    fetch(iReq.url, iReq.options)
                        .then(anilist.handleJsonResponse)
                        .then(anilist.handleMediaData)
                        .catch(anilist.handleError)
                })
            }
        }

        // Phase 3. Setting up auto-downloads (may be redundant now that above schedules auto-download requests already)
        workers.ani.addJob(() => {
            logi(`Job: Double checking all media for auto-downloading`)

            for (const animeInfo of globals.aniDownloader.animes) {
                if (!animeInfo.isSetup && AnimeInfo.isAllDataLoaded(animeInfo)) {
                    logi(`Requesting auto-downloading job for ${animeInfo.title}`)

                    workers.nyaa.addJob(() => {
                        logi(`Job: Setting up auto-downloading for ${animeInfo.title}`)
                        anilist.trySetupAutoDownloading(animeInfo)
                    })
                }
            }

            // Phase 4. Check for any stalled entries
            workers.nyaa.addJob(() => {
                logi(`Job: Checking for stalled entries`)
                qbt.checkForStalledTorrents()
            })
        })
    })

    globals.aniDownloader.lastUpdatedPretty = now()
}

async function updateAnimesOnly() {
    // TODO: Use the finalized list after all user lists aggregation occurs.
    for (animeInfo of globals.aniDownloader.animes) {
        if (animeInfo.isSetup) {
            continue
        }
        await anilist.trySetupAutoDownloading(animeInfo)
        await sleep(settings.SHARED.DELAY)
    }
}

// Saves all cached data
function saveData() {
    logi("Saving cached data")

    try {
        fs.writeFileSync(CONSTANTS.STORAGE.DIRECTORY + CONSTANTS.STORAGE.FILENAME, JSON.stringify(globals))
        logi("Successfully saved cached data")
    } catch (error) {
        loge("Failed to save cached data")
        loge(error)
    }
}

// Loads all cached data
function loadData() {
    logi("aniDownloader loading cached data")

    try {
        var data = fs.readFileSync(CONSTANTS.STORAGE.DIRECTORY + CONSTANTS.STORAGE.FILENAME)
        try {
            globals = JSON.parse(data)
            logi("Successfully loaded cached data")
            dump(globals)
        } catch (error) {
            loge("Failed to parse cached data")
            dump(error)
        }
    } catch (error) {
        loge("Failed to load cached data")
        saveData() // most likely does not exists, create it now.
    }
}

// Updates data to new format 
function migrateData() {
    let dataChanged = false
    for (let animeInfo of globals.aniDownloader.animes) {
        if (animeInfo.noResults === undefined) {
            logi(`Migrating data for ${animeInfo.title} - adding noResults`)
            animeInfo.noResults = false
            dataChanged = true
        }
        if (animeInfo.noSeeders !== undefined) {
            logi(`Migrating data for ${animeInfo.title} - adding noSeeders`)
            delete animeInfo.noSeeders
            dataChanged = true
        }
        if (animeInfo.format === undefined) {
            logi(`Migrating data for ${animeInfo.title} - adding format`)
            animeInfo.format = CONSTANTS.FORMAT.TV
            dataChanged = true
        }
        if (animeInfo.isBlacklisted === undefined) {
            logi(`Migrating data for ${animeInfo.title} - adding isBlacklisted`)
            animeInfo.isBlacklisted = false
            dataChanged = true
        }
        if (animeInfo.observe === undefined) {
            logi(`Migrating data for ${animeInfo.title} - adding observe`)
            animeInfo.observe = ""
            dataChanged = true
        }
        if (animeInfo.isStalled === undefined) {
            logi(`Migrating data for ${animeInfo.title} - adding isStalled`)
            animeInfo.isStalled = false
            dataChanged = true
        }
    }

    if (globals.workActive !== undefined) {
        logi(`Migrating data for globals - removing workActive`)
        delete globals.workActive
        dataChanged = true
    }

    if (dataChanged) {
        logi("Migration occurred, resaving data")
        saveData()
    }
}

// Gets cached data
function getData() {
    logi("Getting cached data")
    return globals.aniDownloader
}

// Indicator if the module is currently working
function isWorkActive() {
    logi("Checking if work is active")
    return workers.ani.isWorking() || workers.nyaa.isWorking()
}

process.on('exit', () => {
    loge("Shutting down")
    dump(globals)
    saveData()
})

process.on('SIGINT', function () {
    logw('User interrupted')
    process.exit()
});


function main() {
    loadData()
    migrateData()


}

/* A bunch of test cases for debugger use
async function main() {
    // updateAll()
    // while (isWorkActive()) {
    //     await new Promise(r => setTimeout(r, 2000));
    // }

    // Test all saved animes
    //await updateAnimesOnly()

    // Test single anime
    // const testAnime = new AnimeInfo(106625, "Haikyuu!! TO THE TOP")
    //await anilist.setupAutoDownloading(testAnime)

    // Standalone 
    addUser("Your Username")
}
*/

main()

module.exports.addUser = addUser
module.exports.removeUser = removeUser
module.exports.setManualRule = setManualRule
module.exports.addManualDownload = addManualDownload
module.exports.resetAnime = resetAnime
module.exports.resolveAnime = resolveAnime
module.exports.updateAll = updateAll
module.exports.getData = getData
module.exports.saveData = saveData
module.exports.loadData = loadData
module.exports.isWorkActive = isWorkActive
module.exports.getResolutionEntries = getResolutionEntries