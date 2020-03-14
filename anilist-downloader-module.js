// node::require() is a method to load modules 
const { graphql, buildSchema } = require('graphql');
const fetch = require('node-fetch')
const util = require('util') // https://stackoverflow.com/questions/10729276/how-can-i-get-the-full-object-in-node-jss-console-log-rather-than-object
const querystring = require('querystring')
const sanitize = require('sanitize-filename')
const fs = require('fs')
const Parser = require('rss-parser');
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
    constructor(id, name) {
        this.mediaId = id       // anilist ID
        this.title = name       // title
        this.isSetup = false    // successfully went thru all auto-download procedures
        this.noResults = false  // failed to find any results
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
    constructor(group, title, episode, quality) {
        this.group = group
        this.title = title 
        this.episode = parseInt(episode)
        this.quality = quality
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
        parseInfoFromFeedEntry: function(entry) {
            logi(`Parsing info from feed entry - ${entry}`)
            const regexPattern = /\[(.+?)\]\s+(.+?)\s+-\s+S?(\d\d)\s+\[(.+?)\]/
            const match = entry.match(regexPattern)
            if (!match) 
                return null
            return new FeedEntry(match[1], match[2], match[3], this.parseQualityFromString(match[4]))
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

        /**
         * Finds the best entry given results.
         * 
         * @param {String} originalTitle The original title (from AniList)
         * @param {FeedEntry} feedResults The list of RSS feed entries
         * @example Original: "Another" finds ["Another", "ImoCho - Another Shitty Sister Manga Adaptation"] returning "Another" for best match
         */
        getBestFeedEntry: function(originalTitle, feedResults) {
            logi(`Finding best entry for ${originalTitle}`)

            // find all entries with unique titles
            var entries = new Map()
            feedResults.forEach(item => {
                var entry = this.parseInfoFromFeedEntry(item["title"])
                if (!entry)
                    return
                if (entries.has(entry.title)) {
                    const existingEntry = entries.get(entry.title)

                    if (entry.quality > existingEntry.quality) {
                        // new entry has better quality
                        entries.set(entry.title, entry)
                    } 

                } else {
                    entries.set(entry.title, entry)
                }
            });

            if (entries.size == 0) {
                logw("No results detected from RSS query.")
                return null
            } else {
                logi("Found unique titles:")
                dump(entries)
            }
            
            // find best match 
            function simpleEvaluator(originalTitle, entryToCheck) {
                let error = Math.abs(originalTitle.length - entryToCheck.title.length)
                if (error == 0) {
                    // lengths are exact, check each character (useful for seasons)
                    for (let i = 0; i < originalTitle.length; i++) {
                        if (originalTitle.charAt(i) != entryToCheck.title.charAt(i)) {
                            error += 1 / originalTitle.length                            
                        }
                    }
                }
                return error
            }

            var bestEntry = null;
            var errorRating = Infinity
            entries.forEach(item => {
                const error = simpleEvaluator(originalTitle, item)
                if (error < errorRating) {
                    bestEntry = item
                    errorRating = error
                }
            })

            logi(`Best title: ${dump(bestEntry)}`)
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
            let parser = new Parser();
            let results = await parser.parseURL(feedUrl)
            return results.items
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
    addFeed: async function(feed, title) {
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
    addRule: async function(feed, title, strictMatchRule) {
        logi(`Adding rule ${title}`)

        const apiUri = '/api/v2/rss/setRule?'

        const safePath = sanitize(title)

        const downloadRule = {
            "enabled": true,
            "mustContain": strictMatchRule ? strictMatchRule : "",
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
            "savePath": settings.QBT.DOWNLOAD_LOCATION + safePath
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
        var element = globals.aniDownloader.animes.find(animeInfo => {
            return animeInfo.title == title;
        })
        if (element) {
            logi("marked")
            element.isSetup = true;
        } else {
            logw(`qbt could not mark cached anime as setup - could not find the anime ${title}`)
        }
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
        title {
        romaji
        english
        native
        }
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
    MediaListCollection(userName: $name, type: ANIME, status: CURRENT) {
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

        var i = 0
        data.data.MediaListCollection.lists.forEach(MediaListGroup => {
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
        loge(error);
    },

    handleMediaData: async function(data) {
        dump(data.data.Media.title)

        // track data 
        var mediaId = data.data.Media.id;
        var title = data.data.Media.title.romaji
        var animeInfo = globals.aniDownloader.animes.find(element => {
            return element.mediaId == mediaId;
        })

        if (!animeInfo) {
            animeInfo = new AnimeInfo(mediaId, title);
            globals.aniDownloader.animes.push(animeInfo);
        }

        await anilist.setupAutoDownloading(animeInfo)
    },

    setupAutoDownloading: async function(animeInfo) {
        const title = animeInfo.title
        logi(title)

        if (animeInfo.isSetup) {
            logi(`${title} is already setup - skipping setting up auto-downloading`)
            return
        }

        // update rules 
        if (animeInfo.manual) {
            // manual mode set
            let feed = trackers.nyaa.generateRssFeedUrl(animeInfo.manual, "", "", false)
            await qbt.addFeed(feed, title)
            await qbt.addRule(feed, title)
        } else if (CONSTANTS.MISC.strict) {
            // update feed 
            let initialFeed = trackers.nyaa.generateRssFeedUrl(title, "1080", CONSTANTS.GROUPS.HORRIBLE_SUBS, false)
            let initialResults = await trackers.nyaa.getRssFeedResults(initialFeed)
            let bestEntry = trackers.common.getBestFeedEntry(title, initialResults)

            if (!bestEntry) {
                logw(`Unable to find any results for ${title} - relaxing search`)

                await sleep(settings.SHARED.DELAY)
                
                initialFeed = trackers.nyaa.generateRssFeedUrl(title, "", "", false)
                initialResults = await trackers.nyaa.getRssFeedResults(initialFeed)
                bestEntry = trackers.common.getBestFeedEntry(title, initialResults)

                if (!bestEntry) {
                    // no results - failed
                    animeInfo.noResults = true
                    logw(`Unable to find any results for ${title} - marking as failed`)
                    return
                }
            }

            let bestFeed = trackers.nyaa.generateRssFeedUrl(bestEntry.title, bestEntry.quality, bestEntry.group, true)
            await qbt.addFeed(bestFeed, title)
            await qbt.addRule(bestFeed, title, `\] ${bestEntry.title} -`)
        } else {
            // update feed (no checks - just add)
            let feed = trackers.nyaa.generateRssFeedUrl(title, "1080", CONSTANTS.GROUPS.HORRIBLE_SUBS)
            await qbt.addFeed(feed, title)
            await qbt.addRule(feed, title)
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

    globals.aniDownloader.users.forEach((userInfo, index, array) => {
        
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
}

// Updates data to new format 
function migrateData() {
    globals.aniDownloader.animes.forEach(animeInfo => {
        if (animeInfo.noResults === undefined) {
            animeInfo.noResults = false
        }
    })
}

// Gets cached data
function getData() {
    logi("Getting cached data")
    return globals.aniDownloader
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

async function main() {
    loadData()
    migrateData()
    // await updateAnimesOnly()
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