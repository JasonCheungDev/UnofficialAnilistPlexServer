// node::require() is a method to load modules 
const { graphql, buildSchema } = require('graphql');
const fetch = require('node-fetch')
const util = require('util') // https://stackoverflow.com/questions/10729276/how-can-i-get-the-full-object-in-node-jss-console-log-rather-than-object
const querystring = require('querystring')
const sanitize = require('sanitize-filename')
const fs = require('fs')
//exeternal
const settings = require('./anilist-downloader-settings')

const asyncReadFile = util.promisify(fs.readFile)
const asyncWriteFile = util.promisify(fs.writeFile)

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
    }
}

class AnimeInfo {
    constructor(id, name) {
        this.mediaId = id;
        this.title = name;
        this.isSetup = false;
    }
}

var globals = {
    aniDownloader: {
        animes: []
    }
}

var trackers = {
    nyaa: {
        generateRssFeed: function(title, quality, group) {
            // might want to change title to " title " (strict matching of title, requires space before and after)
            var uriFriendlyString = encodeURI(group + " " + title + " " + quality)
            return "https://nyaa.si/?page=rss&q=" + uriFriendlyString + "&c=1_2&f=0"    // c=1_2 == Anime - English Translated
        }
    }
}

var qbt = {
    getUrl: function() {
        return 'http://localhost:' + settings.QBT.PORT
    },
    handleResponse: function(response) {
        dump(response)
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

        logi(response)

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
            // return;
        }
  
        this.addRule(feed, title);
    },
    addRule: async function(feed, title) {
        const apiUri = '/api/v2/rss/setRule?'

        const safePath = sanitize(title)

        const downloadRule = {
            "enabled": true,
            "mustContain": "",
            "mustNotContain": "batch",
            "useRegex": false,
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

        dump(queryString)

        const response = await fetch(this.getUrl() + apiUri + queryString, options)

        if (!response.ok) {
            loge("FAILED TO ADD RSS FEED TO QBT:\n" + util.inspect(object, false, null, true))
            return;
        } 

        // track
        var element = globals.aniDownloader.animes.find(animeInfo => {
            return animeInfo.title == title;
        })
        element.isSetup = true;
    },
    queryTorrents: function() {
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

        

        // dump(response)
    }
}

// Here we define our query as a multi-line string
// Storing it in a separate .graphql/.gql file is also possible
var queryAnime = `
query ($id: Int) { # Define which variables will be used in the query (id)
  Media (id: $id, type: ANIME) { # Insert our variables into the query arguments (id) (type: ANIME is hard-coded in the query)
    id
    title {
      romaji
      english
      native
    }
  }
}
`;

var queryUser = `
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
}
`

var queryMediaListCollection = `
query ($name: String) {
    MediaListCollection(userName: $name, type: ANIME, status: CURRENT) {
        lists {
            name
            entries {
                id
                mediaId
            }
        }
    }
}
`

var queryMediaList = `
query {
    MediaList(id: 89369849) {
        id
        userId
        mediaId
    }
}
`

// Define our query variables and values that will be used in the query request
var queryVariables = {
    id: 15125,
    name: "Xaieon"
};

function generateRequest(query, variables) {
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
}

function handleResponse(response) {
    return response.json().then(function (json) {
        return response.ok ? json : Promise.reject(json);
    });
}

function handleData(data) {
    dump(data)

    logi("=====");

    data.data.MediaListCollection.lists.forEach(MediaListGroup => {
        MediaListGroup.entries.forEach(MediaList => {
            var mediaId = MediaList.mediaId;

            // check if necessary 
            var animeInfo = globals.aniDownloader.animes.find(element => {
                return element.mediaId == mediaId;
            })
            if (animeInfo) {
                logi(`aniApi: ${mediaId} is already setup - ignoring.`)
                return;
            }

            var iVar = {
                id: mediaId
            }

            var iReq = generateRequest(queryAnime, iVar)

            fetch(iReq.url, iReq.options)
                .then(handleResponse)
                .then(handleMediaData)
                .catch(handleError);
        });
    });
}

function handleError(error) {
    // alert('Error, check console');
    loge(error);
}

function handleMediaData(data) {

    var mediaId = data.data.Media.id;
    var title = data.data.Media.title.romaji
    var animeInfo = new AnimeInfo(mediaId, title);

    // track data 
    globals.aniDownloader.animes.push(animeInfo);

    logi(title)

    // update feed 
    qbt.addFeed(trackers.nyaa.generateRssFeed(title, '1080', CONSTANTS.GROUPS.HORRIBLE_SUBS), title)
}

// Checks all AniList users and downloads all anime in the "Watching" list.
function updateAll() {
    
    var request = generateRequest(queryMediaListCollection, queryVariables);

    // Make the HTTP Api request
    fetch(request.url, request.options)
        .then(handleResponse)
        .then(handleData)
        .catch(handleError);
}

// Saves all cached data
async function saveData() {
    logi("Saving cached data")

    try {
        // note: we use async the pattern here to guarantee this finishes before proceeding. 
        var error = await asyncWriteFile(CONSTANTS.STORAGE.DIRECTORY + CONSTANTS.STORAGE.FILENAME, JSON.stringify(globals), error => { c})
        if (error) {
            loge("Failed to save cached data! " + error)
        } else {
            logi("Successfully saved cached data")
        }
        
        // fs.writeFile(CONSTANTS.STORAGE.FILENAME, JSON.stringify(globals), function(error) {
        //     if (error) {
        //         loge("aniDownloader failed to save cached data!")
        //     }
        // })

    } catch(error) {
        loge("Failed to save cached data")
        loge(error)
    }

    logi("Finished saving")
}

// Loads all cached data
async function loadData() {
    logi("aniDownloader loading cached data")

    try {
        fs.readFile(CONSTANTS.STORAGE.DIRECTORY + CONSTANTS.STORAGE.FILENAME, function(error, data) {
            if (error) {
                loge("anilist-downloader failed to load data.")
                loge(error);
            } else {
                try {
                    globals = JSON.parse(data)
                    logi("Successfully loaded cached data")
                    dump(globals)
                } catch (error) {
                    loge("Failed to parse cached data")
                }
            }
        })
    } catch(error) {
        loge("Failed to load cached data")
    }
}

module.exports.updateAll = updateAll
module.exports.saveData = saveData
module.exports.loadData = loadData