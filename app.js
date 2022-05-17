var createError = require('http-errors');
var express = require('express');
var path = require('path');
var cookieParser = require('cookie-parser');
var logger = require('morgan');
const querystring = require('querystring')
const cron = require('node-cron')
// external modules
var aniDownloader = require('./anilist-downloader-module')
var plexInviter = require('./plex-auto-invite')
var settings = require('./anilist-downloader-settings')

var indexRouter = require('./routes/index');

var app = express();
app.disable('etag');
const port = 3000

// initialize module
aniDownloader.loadData();

// view engine setup
app.set('views', path.join(__dirname, 'views'));
app.set('view engine', 'pug');

app.use(logger('dev'));
app.use(express.json());
app.use(express.urlencoded({ extended: false }));
app.use(cookieParser());
app.use(express.static(path.join(__dirname, 'public')));

app.use('/', indexRouter);

app.get('/users', function(request, resource) {
  resource.render('users', {
    title: "Users",
    users: aniDownloader.getData().users,
    isWorkActive: aniDownloader.isWorkActive(),
    lastUpdated: aniDownloader.getData().lastUpdatedPretty
  })
})

app.get('/animes', function(request, resource) {
  var animes = aniDownloader.getData().animes.filter((entry) => { return entry.title })
  animes.sort((lhs, rhs) => {
    // const LARGE = 10000
    // const l = (lhs.noResults || lhs.isBlacklisted) ? LARGE : 0
    // const r = (rhs.noResults || rhs.isBlacklisted) ? LARGE : 0
    return lhs.title.localeCompare(rhs.title) // + (l - r)
  })

  resource.render('animes', {
    title: "Animes",
    animes: animes,
    isWorkActive: aniDownloader.isWorkActive(),
    lastUpdated: aniDownloader.getData().lastUpdatedPretty
  })
})

app.get('/anime/:mediaId', function(request, resource) {
  var animes = aniDownloader.getData().animes
  const found = animes.find( element => { return element.mediaId == request.params.mediaId });
  if (found) {
    resource.render('anime', {
      title: "Anime",
      anime: found
    })
  } else {
    resource.send("ERROR: ANIME NOT FOUND") 
  }
})

app.get('/help', function(req, res) {
  res.render('help')
})

app.post('/set_anime_manual_rule', function(req, res) {
  let rule = req.body.rule
  let id = req.body.mediaId
  aniDownloader.setManualRule(id, rule)
  aniDownloader.updateAll()
  res.redirect(`/anime/${id}`)
})

app.post('/add_anilist_user', function(request, resource) {
  let username = request.body.username
  console.log(`ADDING USER ${username}`)

  aniDownloader.addUser(username)

  let redirectUrl = request.body.redirect
  if (!redirectUrl) {
    redirectUrl = '/'
  }

  const query = querystring.stringify({
    "username": username
  });
  resource.redirect(redirectUrl + '?' + query)
})

app.post('/remove_anilist_user', function(request, resource) {
  let username = request.body.username
  console.log(`REMOVING USER ${username}`)

  aniDownloader.removeUser(username)

  resource.redirect('back')
})

app.post('/add_plex_email', function(request, resource) {
  let email = request.body.email
  console.log(`ADDING EMAIL ${email}`)

  plexInviter.inviteUsers([email])

  let redirectUrl = request.body.redirect
  if (!redirectUrl) {
    redirectUrl = '/'
  }

  const query = querystring.stringify({
    "email": email
  });
  resource.redirect(redirectUrl + '?' + query)
})

app.post('/remove_plex_email', function(request, resource) {
  let email = request.body.email
  console.log(`REMOVING EMAIL ${email}`)
  request.send("To remove yourself please login to your Plex account.")
})

app.post('/update', function(req, res) {
  console.log("UPDATING")
  aniDownloader.updateAll();
  res.redirect("back");
})

// catch 404 and forward to error handler
app.use(function(req, res, next) {
  // next(createError(404)); // debugging
  res.render("not_found")
});

// error handler
app.use(function(err, req, res, next) {
  console.error(err);

  // set locals, only providing error in development
  res.locals.message = err.message;
  res.locals.error = req.app.get('env') === 'development' ? err : {};

  // render the error page
  res.status(err.status || 500);
  res.render('error');
});

// graceful shutdown
process.on(`SIGINT`, async function() {
  await aniDownloader.saveData()
  process.exit() // listening for SIGINT will keep the server alive (probably b/c the console is still open)
})

// cron job (every 30 minutes)
cron.schedule("*/30 * * * *", () => {
  console.log("Fetching user data and updating")
  aniDownloader.saveData()
  aniDownloader.updateAll()
})

app.listen(port, () => console.log(`Example app listening on port ${port}!`))

module.exports = app;
