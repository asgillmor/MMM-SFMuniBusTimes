const NodeHelper = require("node_helper");
const fetch = require("node-fetch");
const { parseString } = require("xml2js");
const { promisify } = require("util");
const { URL } = require("url");

const parseXML = promisify(parseString);

module.exports = NodeHelper.create({
  start: function() {
    console.log(this.name + " has started!");
  },

  url_base: new URL("http://webservices.nextbus.com/service/publicXMLFeed"),

  // Fetch train times and generate a clean object only containing the require data
  loadTimes: async function() {
  
  	let url_final = this.url_base;
  	url_final = this.buildUrl(url_final, this.config);
    const data = await fetch(url_final).then(res => res.text());
    console.log("MMM-SFMuniBusTimes - url_final: " + url_final); // Print out error

    const obj = await parseXML(data);
    if (obj == undefined) {
      console.log("MMM-SFMuniBusTimes: parseXML returned null!"); // Print out error
      return;
    }

    if (obj.body === undefined) {
      console.log("MMM-SFMuniBusTimes: obj.body is null!"); // Print out error
      return;
    }
 
    if (obj.body.Error !== undefined) {
      console.log(obj.body.Error[0]._); // Print out error
      return;
    }
    
    const { predictions } = obj.body;
    const schedule = [];
    const seenStops = {};

    // Digest data from each stop's predictions
    for (const pred of predictions) {
      const route = pred.$.routeTag;
      const stop = pred.$.stopTitle;
      let stopData;
      // If a stop has been seen before, update the previously created object
      if (seenStops[stop] !== undefined) {
        stopData = seenStops[stop];
      }
      // If not, create a new object
      else {
        stopData = {
          stop,
          routes: [],
          messages: [],
        };
        // TODO: Prevent message repetition in resulting object
        // Sanitize message objects and add them to stop data
        for (const msg of pred.message) {
          const message = msg.$;
          stopData.messages.push(message);
        }
      }
      stopData.routes.push({ route, trains: [] });
      const { trains } = stopData.routes[stopData.routes.length - 1];

      if(pred.direction !== undefined) {
        let count = 0;
        // Digest data from each train's prediction for a stop
        for (const trainPred of pred.direction[0].prediction) {
          count += 1;
          const train = {
            epochTime: trainPred.$.epochTime,
            seconds: trainPred.$.seconds,
            cars: trainPred.$.vehiclesInConsist,
            delayed: trainPred.$.delayed === true, // Defaults to false if delayed property doesn't exist
          };
          trains.push(train);
          // Only process the next 3 trains for the current route
          if (count >= 3) {
            break;
          }
        }
      }
      
      // Sort routes so they're always ascending alphabetically/numerically
      stopData.routes.sort((a, b) => {
        let aSum = 0,
          bSum = 0;

        // Get the sum of ASCII codes for the first 3 chars of each route names for better accuracy in comparison
        for (let i = 0; i < Math.min(a.route.length, 3); i += 1) {
          aSum += a.route.charCodeAt(i);
        }
        for (let i = 0; i < Math.min(b.route.length, 3); i += 1) {
          bSum += b.route.charCodeAt(i);
        }

        return aSum - bSum;
      });

      if (seenStops[stop] === undefined) {
        schedule.push(stopData);
      }
      seenStops[stop] = stopData;
    }

    // Sort stops in schedule so they're always ascending alphabetically
    schedule.sort((a, b) => {
      let aSum = 0,
        bSum = 0;

      // Get the sum of ASCII codes for the first 4 chars of stop names for better accuracy in comparison
      for (let i = 0; i < Math.min(a.stop.length, 4); i += 1) {
        aSum += a.stop.charCodeAt(i);
      }
      for (let i = 0; i < Math.min(b.stop.length, 4); i += 1) {
        bSum += b.stop.charCodeAt(i);
      }

      return aSum - bSum;
    });

    // Send the schedule to MMM-SFMuniBusTimes
    this.sendSocketNotification("MUNI_TIMINGS", schedule);
  },

  // Build the URL based on the default / user configuration
  buildUrl: function(url, config) {
    const params = [];
    for (let stop in config.stops) {
      for (let route of config.stops[stop]) {
        params.push(`${route}|${stop}`);
      }
    }

    // Set url params based on config
    url.searchParams.append("command", "predictionsForMultiStops");
    url.searchParams.append("a", "sf-muni");
    for (let param of params) {
      url.searchParams.append("stops", param);
    }
    
    return url;
  },

  // Handle messages from MMM-SFMuniBusTimes.js
  socketNotificationReceived: function(notification, payload) {
    // If start message is received, build the URL based on the config file, and get schedule
    if (notification === "START") {
      const config = payload;
//      this.buildUrl(config);
      this.task = setInterval(this.loadTimes.bind(this), config.updateInterval);
    }
    
    // If stop timer message is received, stop timer that updates schedule
    if (notification === "STOP_TIMER") {
      clearInterval(this.task);
    }
    
    // If restart timer message is received, stop current timer (if exists) and start a new one that updates schedule
    if (notification === "RESTART_TIMER") {
      clearInterval(this.task);
      this.task = setInterval(this.loadTimes(), config.updateInterval);
    }
  },
});
