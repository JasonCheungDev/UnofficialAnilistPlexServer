// node::require() is a method to load modules 
const { graphql, buildSchema } = require('graphql');
const fetch = require('node-fetch')
const util = require('util') // https://stackoverflow.com/questions/10729276/how-can-i-get-the-full-object-in-node-jss-console-log-rather-than-object
const querystring = require('querystring')
const sanitize = require('sanitize-filename')
const fs = require('fs')
const Parser = require('rss-parser');
const { si, pantsu } = require('nyaapi')
//external
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
        RED: "\x1b[0m",
        YELLOW: "\x1b[33m"
    },
    MISC: {
        strict: true
    }
}

class AnimeInfo {
    constructor(id, name, format) {
        this.mediaId = id       // anilist ID
        this.format = format    // format (tv,movie,ova) - only special handling for movie
        this.title = name       // title
        this.isSetup = false    // successfully went thru all auto-download procedures
        this.noResults = false  // failed to find any results
        this.isBlacklisted = false// blacklisted (will not download)
        this.manual = ""        // manual title to search for
    }
}

class UserInfo {
    constructor(name) {
        this.username = name
        this.lastUpdated = now()
    }
}

class FeedEntry {
    constructor(link, group, title, episode, quality, isBatch, seeders) {
        this.link = link
        this.group = group
        this.title = title
        this.episode = parseInt(episode)
        this.quality = quality
        this.isBatch = isBatch
        this.seeders = seeders
    }
}

// RUNTIME + SERIALIZED DATA
var globals = {
    aniDownloader: {
        animes: [],
        users: [],
        lastUpdated: Date.now(),
        lastUpdatedPretty: ""
    },
    workActive: 0 // currently saving this so we can track if we were in an active/invalid state
}

function incrementWork() {
    if (globals.workActive == 0) {
        logi(`Work Tracking: Starting at ${now()}`)
    }
    globals.workActive++
}

function decrementWork() {
    if (globals.workActive == 1) {
        logi(`Work Tracking: Finished at ${now()}`)
    }
    else if (globals.workActive == 0) {
        loge(`Work Tracking: decrement work called when no work was active! work: ${globals.workActive}`)
        return
    }
    globals.workActive--
}

// APPLICATION
var shared = {
    markAnimeSetup: function(title) {
        var element = globals.aniDownloader.animes.find(animeInfo => {
            return animeInfo.title == title;
        })

        if (element) {
            logi(`[UPDATE] ${title} is setup`)
            element.isSetup = true
            element.noResults = false
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
        parseStrictTitleFromFeedEntry: function(entry) {
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
        generateStrictTitleFromFeedResults: function(originalTitle, feedResults) {
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
        parseInfoFromFeedEntry: function(link, entry, seeders) {
            logi(`Parsing info from feed entry - ${entry}`)

            // Standard Match
            const regexPattern = /\[(.+?)\]\s+(.+?)\s+-\s+(?:S\d\dE)?(\d\d)\s+\[(.+?)\]/i
            const match = entry.match(regexPattern)
            if (match) {
                return new FeedEntry(link, match[1], match[2], match[3], this.parseQualityFromString(match[4]), false, seeders)
            }

            // Extrapolate Match (batch assumed)
            const groupRegexPattern = /^\[(.+?)\]/
            const groupMatch = entry.match(groupRegexPattern)
            const group = groupMatch ? groupMatch[1] : ""
            const title = this.cleanTitleFromEntry(entry)
            const quality = this.parseQualityFromString(entry)
            return new FeedEntry(link, group, title, -1, quality, true, seeders)
        },

        parseQualityFromString: function(string) {
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

        cleanTitleFromEntry: function(string) {
            return string.replace(/_/g, " ")
                .replace(/\(.+?\)/g, "")
                .replace(/\[.+?\]/g, "")
                .replace(/batch/gi, "")
                .replace(/\d\d-\d\d/g, "")
                .replace(/\..{3}$/, "")
                .trim()
        },

        /**
         * Finds the best entry given results.
         * 
         * @param {String} originalTitle The original title (from AniList)
         * @param {FeedEntry} feedResults The list of RSS feed entries
         * @example Original: "Another" finds ["Another", "ImoCho - Another Shitty Sister Manga Adaptation"] returning "Another" for best match
         */
        getBestFeedEntry: function(originalTitle, feedResults) {
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

            function entryComparator(lhs, rhs) {
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
        generateRssFeedUrl: function(title, quality, group, makeStrict) {
            // c=1_2 == Anime - English Translated
            if (makeStrict) {
                title = `"${title}"`
            }
            var uriFriendlyString = "https://nyaa.si/?page=rss&q=" + encodeURI(group + " " + title + " " + quality) + "&c=1_2&f=0"
            logi(`nya.generateRssFeedUrl: ${uriFriendlyString}`)
            return uriFriendlyString
        },

        getRssFeedResults: async function(feedUrl) {
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

        getSearchResults: async function(search) {
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
                    link: result.links.file,
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
    getUrl: function() {
        return 'http://localhost:' + settings.QBT.PORT
    },
    handleResponse: function(response) {
        // dump(response)
    },
    authenticate: async function() {
        var apiUri = "/api/v2/auth/login?"

        var queryString = querystring.stringify({
            username: settings.QBT.USERNAME,
            password: settings.QBT.PASSWORD
        })

        const response  = await fetch(this.getUrl() + apiUri + queryString, {
            credentials: "same-origin"
        })

        // example: SID=UvanerY1qZdKhnH64EZJbSbkNnqX14Yz; HttpOnly; path=/; SameSite=Strict
        var cookie = response.headers.raw()['set-cookie'][0]

        // example: SID=UvanerY1qZdKhnH64EZJbSbkNnqX14Yz
        var parsedCookie = cookie.substr(0, cookie.indexOf(';'))
        
        logi("successful login: " + parsedCookie)

        return parsedCookie
    },
    getSavePath: function(animeInfo) {
        const directory = settings.QBT.DOWNLOAD_LOCATION + (animeInfo.format == CONSTANTS.FORMAT.MOVIE ? "Anime Movie/" : "Anime/")
        const safePath = sanitize(animeInfo.title)
        return directory + safePath
    },
    addFeed: async function(feed, title) {
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

        const safePath = sanitize(title)

        const queryString = querystring.stringify({
            url: feed,
            path: safePath
        })

        const SID = await this.authenticate()

        const options = {
            method: 'GET', // WARNING: MUST BE GET (despite the docs)
            headers: {
                'Cookie': SID
            }
        }

        const response = await fetch(this.getUrl() + apiUri + queryString, options)

        if (!response.ok) {
            loge("FAILED TO ADD RSS FEED TO QBT:\n" + util.inspect(response, false, null, true))
        }
    },
    removeFeed: async function(title) {
        // setup request
        const apiUri = '/api/v2/rss/removeItem?'

        const safePath = sanitize(title)

        const queryString = querystring.stringify({
            path: safePath
        })

        const SID = await this.authenticate()

        const options = {
            method: 'GET', // WARNING: MUST BE GET (despite the docs)
            headers: {
                'Cookie': SID
            }
        }

        const response = await fetch(this.getUrl() + apiUri + queryString, options)

        if (!response.ok) {
            logi(`Failed to remove RSS feed title ${title} - this is normal for initial setup.`)
        }
    },
    addRule: async function(feed, title, animeInfo, strictMatchRule) {
        logi(`[QBT] Adding rule ${title}`)

        const apiUri = '/api/v2/rss/setRule?'

        const downloadRule = {
            "enabled": true,
            "mustContain": strictMatchRule ? strictMatchRule.replace(/\(/g, "\\(").replace(/\)/g, "\\)") : "", // escape brackets if detected
            "mustNotContain": strictMatchRule ? "batch" : "",
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

        const queryString = querystring.stringify({
            ruleName: title,
            ruleDef: JSON.stringify(downloadRule)
        })

        const SID = await this.authenticate()

        const options = {
            method: 'GET', // WARNING: MUST BE GET (despite the docs)
            headers: {
                'Cookie': SID
            }
        }

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
    queryTorrents: function() {
        /*
        // var SID = await this.authenticate()

        this.authenticate()
            .then(onAuthenticate);

        function onAuthenticate(SID) {

            logi("onAuthenticate " + SID)

            var apiUri = '/api/v2/torrents/info'
            
            //var apiUri = 'api/v2/rss/addFeed?'

            var queryString = querystring.stringify({
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
    addTorrent: async function(title, animeInfo, torrentUrl) {
        logi(`[QBT] Adding torrent: ${torrentUrl} for title: ${title}`)

        const apiUri = '/api/v2/torrents/add?'

        const queryString = querystring.stringify({
            urls: torrentUrl,
            savepath: this.getSavePath(animeInfo),
            category: "Anime"
        })

        const SID = await this.authenticate()

        const options = {
            method: 'GET', // WARNING: MUST BE GET (despite the docs)
            headers: {
                'Cookie': SID
            }
        }

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
    }
}

// ANILIST API

var anilist = {
    // QUERIES 

    // Here we define our query as a multi-line string
    // Storing it in a separate .graphql/.gql file is also possible
    queryAnime: 
`query ($id: Int) { # Define which variables will be used in the query (id)
    Media (id: $id, type: ANIME) { # Insert our variables into the query arguments (id) (type: ANIME is hard-coded in the query)
        id
        format
        title {
            romaji
            english
            native
        }
        countryOfOrigin
    }
}`,

    queryUser:
`query ($name: String) {
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

    queryMediaListCollection: 
`query ($name: String) {
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

    queryMediaList: 
`query {
    MediaList(id: 89369849) {
        id
        userId
        mediaId
    }
}`,

    // Define our query variables and values that will be used in the query request
    generateQueryVariables: function(username) {
        return {
            name: username
        }
    },

    // COMMON

    generateRequest: function(query, variables) {
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

    handleJsonResponse: function(response) {
        return response.json().then(function (json) {
            return response.ok ? json : Promise.reject(json);
        });
    },

    // QUERY SPECIFIC

    handleUserListdata: function(data) {
        logi("=====");

        decrementWork()

        var i = 0
        data.data.MediaListCollection.lists.forEach(MediaListGroup => {
            
            if (!settings.ANI.LISTS.includes(MediaListGroup.name)) {
                return
            }

            MediaListGroup.entries.forEach((MediaList, index, array) => {
                var mediaId = MediaList.mediaId;

                // check if necessary 
                var animeInfo = globals.aniDownloader.animes.find(element => {
                    return element.mediaId == mediaId;
                })
                if (animeInfo && animeInfo.isSetup) {
                    logi(`aniApi: ${mediaId} is already setup - ignoring.`)
                    return;
                }

                // work necessary
                incrementWork()

                var iVar = {
                    id: mediaId
                }

                var iReq = anilist.generateRequest(anilist.queryAnime, iVar)

                // stagger requests
                setTimeout(() => {
                    fetch(iReq.url, iReq.options)
                        .then(anilist.handleJsonResponse)
                        .then(anilist.handleMediaData)
                        .catch(anilist.handleError)
                }, settings.SHARED.DELAY * i++)

            });
        }); // pass scope into block
    },

    handleError: function(error) {
        loge(error)
        decrementWork()
    },

    handleMediaData: async function(data) {
        dump(data.data.Media.title)

        // track data 
        var mediaId = data.data.Media.id
        var title = data.data.Media.title.romaji
        var format = data.data.Media.format
        var country = data.data.Media.countryOfOrigin
        var animeInfo = globals.aniDownloader.animes.find(element => {
            return element.mediaId == mediaId
        })

        if (!animeInfo) {
            animeInfo = new AnimeInfo(mediaId, title, format)
            
            // blacklist check
            if (settings.ANI.BLACKLISTED_ORIGINS.includes(country)) {
                animeInfo.isBlacklisted = true
                animeInfo.isSetup = true
                logi(`${title} is blacklisted - will not download`)
            }
            
            globals.aniDownloader.animes.push(animeInfo)
        }
        
        decrementWork()
        
        await anilist.setupAutoDownloading(animeInfo)
    },

    setupAutoDownloading: async function(animeInfo) {
        const title = animeInfo.title
        logi(title)

        if (animeInfo.isSetup) {
            logi(`${title} is already setup - skipping setting up auto-downloading`)
            return
        }

        // work necessary
        incrementWork()

        // update rules 
        if (animeInfo.manual) {
            // manual mode set
            let feed = trackers.nyaa.generateRssFeedUrl(animeInfo.manual, "", "", false)
            await qbt.addFeed(feed, title)
            await qbt.addRule(feed, title, animeInfo)
        } else if (CONSTANTS.MISC.strict) {
            // update feed 
            const relaxedTitle = title.replace(/[^a-zA-Z\d\s]/g, " ")
            const results = await trackers.nyaa.getSearchResults(relaxedTitle)
            const bestEntry = trackers.common.getBestFeedEntry(title, results)

            if (bestEntry) {
                if (bestEntry.isBatch) {
                    await qbt.addTorrent(title, animeInfo, bestEntry.link)
                } else {
                    let bestFeed = trackers.nyaa.generateRssFeedUrl(bestEntry.title, bestEntry.quality, bestEntry.group, true)
                    await qbt.addFeed(bestFeed, title)
                    await qbt.addRule(bestFeed, title, animeInfo, `\] ${bestEntry.title} -`)
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
        }

        decrementWork()
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

    globals.aniDownloader.users = globals.aniDownloader.users.filter( userInfo => {
        return userInfo.username != name
    });
}

function setManualRule(mediaId, rule) {
    logi(`Adding manual rule for ${mediaId} with rule ${rule}`)

    let animeInfo = globals.aniDownloader.animes.find( anime => {
        return anime.mediaId == mediaId
    });

    if (!animeInfo) {
        loge(`Unable to add manual rule, could not find anime!`)
        return
    }

    animeInfo.manual = rule
    animeInfo.isSetup = false
    animeInfo.noResults = false
}

// Checks all AniList users and downloads all anime in the "Watching" list.
function updateAll() {
    logi("Module updating all")

    if (isWorkActive()) {
        logw("Work is already active - skipping updateAll()")
        return
    }

    globals.aniDownloader.users.forEach((userInfo, index, array) => {
        
        incrementWork()

        // stagger requests
        setTimeout(() => {

            userInfo.lastUpdated = now()

            var request = anilist.generateRequest(anilist.queryMediaListCollection, { name: userInfo.username });
    
            // Make the HTTP Api request
            fetch(request.url, request.options)
                .then(anilist.handleJsonResponse)
                .then(anilist.handleUserListdata)
                .catch(anilist.handleError);
    
        }, settings.SHARED.DELAY * index)

    })

    globals.aniDownloader.lastUpdatedPretty = now()
}

async function updateAnimesOnly() {
    // TODO: Use the finalized list after all user lists aggregation occurs.
    for (animeInfo of globals.aniDownloader.animes) {
        if (animeInfo.isSetup) {
            continue
        }
        await anilist.setupAutoDownloading(animeInfo)
        await sleep(settings.SHARED.DELAY)
    }
}

// Saves all cached data
function saveData() {
    logi("Saving cached data")

    try {
        fs.writeFileSync(CONSTANTS.STORAGE.DIRECTORY + CONSTANTS.STORAGE.FILENAME, JSON.stringify(globals))
        logi("Successfully saved cached data")
    } catch(error) {
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
    } catch(error) {
        loge("Failed to load cached data")
        saveData() // most likely does not exists, create it now.
    }

    if (globals.workActive > 0) {
        loge("loadData() active work count was not 0!")
        globals.workActive = 0
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
    }

    if (globals.workActive === undefined) {
        logi(`Migrating data for globals - adding workActive`)
        globals.workActive = 0
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
    return globals.workActive > 0
}

process.on('exit', () => {
    loge("Shutting down")
    dump(globals)
    saveData()
})

process.on('SIGINT', function() {
  logw('User interrupted')
  process.exit()
});


function main() {
    loadData()
    migrateData()

    // Test all saved animes
    //await updateAnimesOnly()

    // Test single anime
    // const testAnime = new AnimeInfo(106625, "Haikyuu!! TO THE TOP")
    //await anilist.setupAutoDownloading(testAnime)
    
    /* Standalone 
    addUser("Your Username")
    */
}
main()

module.exports.addUser = addUser
module.exports.removeUser = removeUser
module.exports.setManualRule = setManualRule
module.exports.updateAll = updateAll
module.exports.getData = getData
module.exports.saveData = saveData
module.exports.loadData = loadData
module.exports.isWorkActive = isWorkActive