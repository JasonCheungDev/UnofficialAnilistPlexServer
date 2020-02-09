var createError = require('http-errors');
var express = require('express');
var path = require('path');
var cookieParser = require('cookie-parser');
var logger = require('morgan');
const querystring = require('querystring')
// external modules
var aniDownloader = require('./anilist-downloader-module')
var plexInviter = require('./plex-auto-invite')
var settings = require('./anilist-downloader-settings')

var indexRouter = require('./routes/index');
var usersRouter = require('./routes/users');

var app = express();
const port = 3000

// initialize module
aniDownloader.loadData();

// view engine setup
app.set('views', path.join(__dirname, 'views'));
app.set('view engine', 'jade');

app.use(logger('dev'));
app.use(express.json());
app.use(express.urlencoded({ extended: false }));
app.use(cookieParser());
app.use(express.static(path.join(__dirname, 'public')));

app.use('/', indexRouter);
// app.use('/users', usersRouter);


// REMOVE
app.get('/test', function(request, resource) {
  resource.render('test', {
    title: "Test Page TITLE!",
    message: "Welcome to AniDownloader TEST TEST TEST!"
  })
})

// REMOVE
app.get('/user', function(request, resource) {
  console.log(aniDownloader.getData())
  resource.render('user', {
    animes: aniDownloader.getData().animes
  })
})

app.get('/users', function(request, resource) {
  resource.render('users', {
    title: "Users",
    users: aniDownloader.getData().users
  })
})

app.get('/animes', function(request, resource) {
  resource.render('animes', {
    title: "Animes",
    animes: aniDownloader.getData().animes
  })
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

app.put('/update', function(request, resource) {
  console.log("UPDATING")
  aniDownloader.updateAll();
})

// catch 404 and forward to error handler
app.use(function(req, res, next) {
  next(createError(404));
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

app.listen(port, () => console.log(`Example app listening on port ${port}!`))

module.exports = app;
