/**
 * Module dependencies.
 */

const express = require('express')
  , routes = require('./routes')
  , user = require('./routes/user')
  , hike = require('./routes/hike')
  , http = require('http')
  , path = require('path')
  , mysql = require('mysql2')
  , async = require('async')
  , morgan = require('morgan')
  , bodyParser = require('body-parser')
  , methodOverride = require('method-override')
  , { HttpRequest } = require('@aws-sdk/protocol-http')
  , { SignatureV4 } = require('@aws-sdk/signature-v4')
  , { defaultProvider } = require("@aws-sdk/credential-provider-node")
  , { Hash } = require('@aws-sdk/hash-node')
  , { formatUrl } = require('@aws-sdk/util-format-url');

const app = express();

app.set('port', process.env.PORT || 3000);
app.set('views', __dirname + '/views');
app.set('view engine', 'pug');
app.use(morgan('dev'));
app.use(methodOverride());
app.use(bodyParser.urlencoded({ extended: true }));
app.use(bodyParser.json());

const { RDS_HOSTNAME, RDS_PORT, RDS_USERNAME, REGION, RDS_DATABASE } = process.env

const getIamAuthToken = async() => {
  // I don't want to use the older v2 SDK (which had the signer for RDS) 
  // The code below is inspired by comments from: https://github.com/aws/aws-sdk-js-v3/issues/1823
  const signer = new SignatureV4({
      service: 'rds-db',
      region: REGION,
      credentials: defaultProvider(),
      sha256: Hash.bind(null, 'sha256')
  })

  const request = new HttpRequest({
      method: 'GET',
      protocol: 'https',
      hostname: RDS_HOSTNAME,
      port: RDS_PORT,
      query: {
        Action: 'connect',
        DBUser: RDS_USERNAME
      },
      headers: {
          host: `${RDS_HOSTNAME}:${RDS_PORT}`,
      },
  })
  
  const presigned = await signer.presign(request, {
      expiresIn: 900
  })
  
  return formatUrl(presigned).replace(`https://`, '')
} 
// https://docs.aws.amazon.com/lambda/latest/dg/configuration-database.html

function init() {
  app.get('/', routes.index);
  app.get('/users', user.list);
  app.get('/hikes', hike.index);
  app.post('/add_hike', hike.add_hike);

  http.createServer(app).listen(app.get('port'), function(){
    console.log("Express server listening on port " + app.get('port'));
  });
}

var client = null;
async.series([
  function initConnection(callback) {
    getIamAuthToken().then((token) => {
      console.log('Creating connection')
      let connectionConfig = {
          host     : RDS_HOSTNAME,
          user     : RDS_USERNAME,
          password : token,
          port     : RDS_PORT,
          database : RDS_DATABASE,
          ssl      : 'Amazon RDS',
          authPlugins: { mysql_clear_password: () => () => token}
      }
      client = mysql.createConnection(connectionConfig)
      app.set('connection', client)
      return callback()
    }).catch((error) => { console.log(error); return callback(error) }) 
  },
  function connect(callback) {
    console.log("Connecting to database")
    client.connect(callback);
  },
  function clear(callback) {
    console.log("Dropping existing db")
    client.query(`DROP DATABASE IF EXISTS ${RDS_DATABASE}`, callback);
  },
  function create_db(callback) {
    console.log("Creating new database")
    client.query(`CREATE DATABASE ${RDS_DATABASE}`, callback);
  },
  function use_db(callback) {
    client.query(`USE ${RDS_DATABASE}`, callback);
  },
  function create_table(callback) {
     client.query('CREATE TABLE HIKES (' +
                         'ID VARCHAR(40), ' +
                         'HIKE_DATE DATE, ' +
                         'NAME VARCHAR(40), ' +
                         'DISTANCE VARCHAR(40), ' +
                         'LOCATION VARCHAR(40), ' +
                         'WEATHER VARCHAR(40), ' +
                         'PRIMARY KEY(ID))', callback);
  },
  function insert_default(callback) {
    var hike = {HIKE_DATE: new Date(), NAME: 'Rainy hike',
          LOCATION: 'Mt Rainier', DISTANCE: '4,027m vertical', WEATHER:'Bad'};
    client.query('INSERT INTO HIKES set ?', hike, callback);
  }
], function (err, results) {
  if (err) {
    console.log('Exception initializing database.');
    throw err;
  } else {
    console.log('Database initialization complete.');
    init();
  }
});
