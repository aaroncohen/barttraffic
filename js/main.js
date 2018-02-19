import {BartAPI} from './bart_api.js'

var map;
var infowindow;
var bartapi = new BartAPI();


$(() => {
        console.log('Initializing map');
        map = new google.maps.Map(document.getElementById('map'), {
            center: {lat: 37.804872, lng: -122.295140},
            zoom: 11
        });

        bartapi.stationList()
            .then(stations => stationListToMarkers(stations))
            .then(stationMarkers => createStationLinks(stationMarkers))
            .then(({stationMarkers, stationLinks}) => createStationDetails(stationMarkers, stationLinks))
            .catch(error => {
                console.log(error)});
    });

function createStationLinks(stationMarkers) {
    // Create a map of stations allowing lookup by abbreviation to get north and south connected stations and relevant
    // routes.

    // NOTE: Using routeColor here because it's the only indication of the actual route in the estimated times later.
    // NOTE: Direction can vary by route despite heading in the same physical direction between two stations.

    let stationLinks = {};

    return bartapi.routeList()
        .then(routes => {
            let routePromises = [];
            for (let route of routes) {
                routePromises.push(bartapi.routeDetail(route.number)
                    .then(routeDetails => {
                        let prevAbbr = null;
                        for (let abbr of routeDetails.config.station) {
                            if (prevAbbr === null) {
                                prevAbbr = abbr;
                                continue;  // Skip first one so that we have something to associate
                            }

                            // Ensure structure
                            if (!stationLinks[abbr]) {
                                stationLinks[abbr] = {byStation: {}};
                            }

                            if (!stationLinks[abbr].byStation[prevAbbr]) {
                                stationLinks[abbr].byStation[prevAbbr] = {}
                            }

                            stationLinks[abbr].byStation[prevAbbr][routeDetails.color] = routeDetails.direction;

                            prevAbbr = abbr;
                        }
                    })
                );
            }
            return routePromises;
        })
        .then(routePromises => Promise.all(routePromises))
        .then(() => {return {stationMarkers: stationMarkers, stationLinks: stationLinks}});
}

function createStationDetails(stationMarkers, stationLinks) {
    let stationPromises = [];

    // For each station, get estimates, figure out which previous station the estimate is from, then generate segments
    for (let stationAbbr of Object.keys(stationLinks)) {
        stationPromises.push(bartapi.estimatedDepartures(stationAbbr)
            .then(estimates => {
                let segments = [];
                if (estimates && estimates.length > 0) {
                    let allEstimates = [].concat([], ...estimates.map(dest => dest.estimate));

                    // Collect arrival times, ordered by route and direction
                    let routeDelays = {};
                    for (let trainEst of allEstimates) {
                        if (!routeDelays[trainEst.color]) {
                            routeDelays[trainEst.color] = {North: [], South: []};
                        }
                        routeDelays[trainEst.color][trainEst.direction].push(parseInt(trainEst.delay))
                    }

                    // Get average estimate for all trains coming from previous station
                    let prevStationEstimates = {};
                    for (let [prevStationAbbr, colorDirections] of Object.entries(stationLinks[stationAbbr].byStation)) {
                        if (!prevStationEstimates[prevStationAbbr]) {
                            prevStationEstimates[prevStationAbbr] = [];
                        }

                        for (let [color, direction] of Object.entries(colorDirections)) {
                            if (!routeDelays[color]) { continue; }
                            let delays = routeDelays[color][direction];
                            prevStationEstimates[prevStationAbbr].push(...delays)
                        }
                    }

                    // Create Segment for each previous station
                    for (let [prevStationAbbr, estimates] of Object.entries(prevStationEstimates)) {
                        segments.push(polylineForStations([stationMarkers[prevStationAbbr], stationMarkers[stationAbbr]],
                                                          avgDelay(estimates)))
                    }

                    stationMarkers[stationAbbr].estimatesHTML = formatStationInfo(
                        stationMarkers[stationAbbr].title,
                        estimates
                    )
                }
                return {stationAbbr, marker: stationMarkers[stationAbbr],
                        estimates, segments};
            })
            .catch(error => {
                console.log(error);
                return {stationAbbr: stationAbbr, marker: stationMarkers[stationAbbr],
                        estimates: [], segments: []}
            })
        )
    }

    return Promise.all(stationPromises)
        .then(stationDetailResults => {
            // TODO: return only segments, markers, and links. Schedule periodic refreshes, cleaning up segments, then
            // TODO: rerunning this function.
            let stationDetails = stationDetailResults.reduce(
                (obj, stationDetail) => {
                    attachEstimatesWindowToMarker(stationDetail.marker, stationDetail.estimates, map);
                    obj[stationDetail.stationAbbr] = stationDetail;
                    return obj;
                }, {});

            return {stationDetails, stationMarkers, stationLinks}
        });
}

function avgDelay(delays) {
    let filteredDelays = delays.filter(num => num <= 90);

    // If there aren't any non outliers, use the outliers
    if (!filteredDelays || !filteredDelays.length) {
        filteredDelays = delays;
    }

    if (filteredDelays && filteredDelays.length) {
        return filteredDelays.reduce((total, num) => total + num) / filteredDelays.length;
    } else {
        return 0
    }
}

function lineColorForEstimate(delay) {
    if (delay > 30) {
        return 'red';
    } else if (delay > 5) {
        return 'orange';
    } else {
        return 'green';
    }
}

function stationListToMarkers(stations) {
    let stationMarkers = {};

    for (let station of stations) {
        let location = new google.maps.LatLng(parseFloat(station.gtfs_latitude), parseFloat(station.gtfs_longitude));

        stationMarkers[station.abbr] = new google.maps.Marker({
            title: station.name,
            position: location,
            map: map,
            opacity: 0.5,
            icon: {
                path: google.maps.SymbolPath.CIRCLE,
                scale: 6,
                strokeColor: 'blue'
            }
        });
    }

    return stationMarkers;
}

function polylineForStations(stationMarkers, estimate) {
    let locations = stationMarkers.map(marker => marker.position);

    var lineSymbol = {
        path: google.maps.SymbolPath.FORWARD_OPEN_ARROW,
        scale: 2
    };

    // Cut line between stations at midpoint and set the start point to the midpoint -- this will allow us to see
    // each direction clearly
    let midpoint = middlePoint(locations[0].lat(), locations[0].lng(),
        locations[1].lat(), locations[1].lng());

    let newStart = new google.maps.LatLng(midpoint[0], midpoint[1]);

    return new google.maps.Polyline({
        path: [newStart, locations[1]],
        geodesic: true,
        strokeColor: lineColorForEstimate(estimate),
        strokeOpacity: 1,
        strokeWeight: 5,
        icons: [{
            icon: lineSymbol,
            repeat: '20px'
        }],
        map: map
    });
}

function reverseDirection(direction) {
    if (direction === 'North') {
        return 'South'
    } else {
        return 'North';
    }
}

function formatStationInfo(stationName, estimates) {
    return `
        <h5>${stationName}</h5>
        <table class="table">
            <thead>
                <tr>
                    <th scope="col">Destination</th>
                    <th scope="col">ETA</th>
                    <th scope="col">Delay</th>
                </tr>
            </thead>
            <tbody>
                ${estimates.map((destination) => `
                    <tr>
                        <td>${destination.destination}</td>
                        <td>${destination.estimate.map((train) => `<div class="colorbox"
                                                                         style="background-color: ${train.hexcolor}"></div>
                                                                    ${train.minutes}`).join('<br>')}</td>
                        <td>${destination.estimate.map((train) => train.delay).join('<br>')}</td>
                    </tr>
                `).join('')}
            </tbody>
        </table>`;
}

function attachEstimatesWindowToMarker(marker, estimates, map) {
    if (!infowindow) {
        infowindow = new google.maps.InfoWindow({content: ''});
        map.addListener('click', () => {
            infowindow.close();
        })
    }

    marker.addListener('click', () => {
        if (marker.hasOwnProperty('estimatesHTML') && marker.estimatesHTML) {
            infowindow.setContent(marker.estimatesHTML);
        } else {
            infowindow.setContent(`<h5>No estimates available.</h5>`);
        }
        infowindow.open(map, marker);
    });
}


/*
 * Find midpoint between two coordinates points
 * Source : http://www.movable-type.co.uk/scripts/latlong.html
 */

//-- Define radius function
function toRad(num) {
    return num * Math.PI / 180;
}

//-- Define degrees function
function toDeg(num) {
    return num * (180 / Math.PI);
}

//-- Define middle point function
function middlePoint(lat1, lng1, lat2, lng2) {

    //-- Longitude difference
    var dLng = toRad(lng2 - lng1);

    //-- Convert to radians
    lat1 = toRad(lat1);
    lat2 = toRad(lat2);
    lng1 = toRad(lng1);

    var bX = Math.cos(lat2) * Math.cos(dLng);
    var bY = Math.cos(lat2) * Math.sin(dLng);
    var lat3 = Math.atan2(Math.sin(lat1) + Math.sin(lat2), Math.sqrt((Math.cos(lat1) + bX) * (Math.cos(lat1) + bX) + bY * bY));
    var lng3 = lng1 + Math.atan2(bY, Math.cos(lat1) + bX);

    //-- Return result
    return [toDeg(lat3), toDeg(lng3)];
}
