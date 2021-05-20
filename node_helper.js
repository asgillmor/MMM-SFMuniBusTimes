const NodeHelper = require("node_helper");
const fetch = require("node-fetch");
const request = require('request');
const {
    parseString
} = require("xml2js");
const {
    promisify
} = require("util");
const {
    URL
} = require("url");

const parseXML = promisify(parseString);

module.exports = NodeHelper.create({
    start: function() {
        console.log(this.name + " has started!");
    },

    url_base: new URL("http://webservices.nextbus.com/service/publicXMLFeed"),

    request_callback: async function(error, response, body) {
        const obj = await parseXML(body);
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

        const predictionsArray = obj.body.predictions;
        const schedule = [];
        const seenStops = {};

        // Digest data from each stop's predictions
        for (const predictions of predictionsArray) {
            const routeTag = predictions.$.routeTag;
            const stopTitle = predictions.$.stopTitle;
            const stopTag = predictions.$.stopTag;
            
            let stopData;

            let directionTitle = undefined;
            
            // if there are no predictions, the direction title is here
            if (predictions.$.dirTitleBecauseNoPredictions !== undefined) {
            	directionTitle = predictions.$.dirTitleBecauseNoPredictions;
            }
            
            // If a stop has been seen before, update the previously created object
            if (seenStops[stopTag] !== undefined) {
                stopData = seenStops[stopTag];
            }
            // If not, create a new object
            else {
                stopData = {
                    stopTitle,
                    directionTitle,
                    routes: [],
                    messages: [],
                };
                // TODO: Prevent message repetition in resulting object
                // Sanitize message objects and add them to stop data
                for (const msg of predictions.message) {
                    const message = msg.$;
                    stopData.messages.push(message);
                }
            }
            stopData.routes.push({
                routeTag,
                trains: []
            });
            const {
                trains
            } = stopData.routes[stopData.routes.length - 1];

            if (predictions.direction !== undefined) {
            	// if there are predictions, then the direction title is here
            	let directionFirst = predictions.direction[0];
            	directionTitle = directionFirst.title;
            	
                let count = 0;
                // Digest data from each train's prediction for a stop
                for (const trainPred of directionFirst.prediction) {
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
                for (let i = 0; i < Math.min(a.routeTag.length, 3); i += 1) {
                    aSum += a.routeTag.charCodeAt(i);
                }
                for (let i = 0; i < Math.min(b.routeTag.length, 3); i += 1) {
                    bSum += b.routeTag.charCodeAt(i);
                }

                return aSum - bSum;
            });

            if (seenStops[stopTag] === undefined) {
                schedule.push(stopData);
            }
            
            stopData.directionTitle = directionTitle;
            seenStops[stopTag] = stopData;
        }

        // Sort stops in schedule so they're always ascending alphabetically
        schedule.sort((a, b) => {
            let aSum = 0,
                bSum = 0;

            // Get the sum of ASCII codes for the first 4 chars of stop names for better accuracy in comparison
            for (let i = 0; i < Math.min(a.stopTitle.length, 4); i += 1) {
                aSum += a.stopTitle.charCodeAt(i);
            }
            for (let i = 0; i < Math.min(b.stopTitle.length, 4); i += 1) {
                bSum += b.stopTitle.charCodeAt(i);
            }

            return aSum - bSum;
        });

        // Send the schedule to MMM-SFMuniBusTimes
        this.sendSocketNotification("MUNI_TIMINGS", schedule);
    },

    // Fetch train times and generate a clean object only containing the required data
    getTimes: function(payload) {

        const config = payload;
        let url_final = new URL(this.url_base);
        url_final = this.buildUrl(url_final, config);
        console.log("MMM-SFMuniBusTimes - url_final: " + url_final); // Print out error

        request({
            url: url_final,
            method: 'GET'
        }, this.request_callback.bind(this));
    },

    // Build the URL based on the default / user configuration
    buildUrl: function(url, config) {
        //    console.log("MMM-SFMuniBusTimes - buildUrl config: " + JSON.stringify(config, null, 4));
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
        if (notification === "GET_MUNI_TIMINGS") {
            this.getTimes(payload.config);
        }
    },
});
