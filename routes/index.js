var express = require('express');
const settings = require('../anilist-downloader-settings.js')
var router = express.Router();

/* GET home page. */
router.get('/', function(req, res, next) {
  var data = {
    title: settings.WEB.TITLE
  };

  if (req.query.username)
    data.username = req.query.username;

  if (req.query.email)
    data.email = req.query.email;

  res.render('index', data);
});

module.exports = router;
