import {BartAPI} from './bart_api.js'

var map;
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
            .then(({stationMarkers, stationLinks}) => createStationDetails(stationMarkers, stationLinks));
    });

function createStationLinks(stationMarkers) {
    // Create a map of stations allowing lookup by abbreviation to get north and south connected stations and relevant
    // routes.

    // NOTE: Using routeColor here because it's the only indication of the actual route in the estimated times later.
    // Structure: stationLinks[abbreviation][direction][routeColor] = [stationAbrv, stationAbrv...]
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
                                stationLinks[abbr] = stationMarkers[abbr]
                            }

                            if (!stationLinks[abbr][reverseDirection(routeDetails.direction)]) {
                                stationLinks[abbr][reverseDirection(routeDetails.direction)] = {}
                            }

                            stationLinks[abbr][reverseDirection(routeDetails.direction)][routeDetails.color] = stationMarkers[prevAbbr];

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
        let station = stationLinks[stationAbbr];

        stationPromises.push(bartapi.estimatedDepartures(stationAbbr)
            .then(estimates => {
                let segments = [];
                if (estimates && estimates.length > 0) {
                    for (let destination of estimates) {  // Destination is last station train will visit
                        let routeDelays = {'North': {}, 'South': {}};

                        for (let trainEst of Object.values(destination.estimate)) {
                            if (!routeDelays[trainEst.direction].hasOwnProperty(trainEst.color)) {
                                routeDelays[trainEst.direction][trainEst.color] = [];
                            }
                            routeDelays[trainEst.direction][trainEst.color].push(parseInt(trainEst.delay))
                        }

                        for (let direction of ['North', 'South']) {
                            // TODO: I think I've got the directions in these data structures reversed, though the
                            // TODO: output is correct

                            // Collect routes that come from each prev station
                            let prevStationRoutes = {};
                            if (stationLinks[stationAbbr][direction]) {
                                for (let [color, stn] of Object.entries(stationLinks[stationAbbr][direction])) {
                                    if (!prevStationRoutes[stn.label]) {
                                        prevStationRoutes[stn.label] = new Set()
                                    }
                                    prevStationRoutes[stn.label].add(color);
                                }
                            }

                            // Get average estimate for all trains coming from previous station
                            let prevStationEstimates = {};
                            for (let [prevStationAbbr, colors] of Object.entries(prevStationRoutes)) {
                                prevStationEstimates[prevStationAbbr] =
                                    [...colors].map(color => avgDelay(routeDelays[reverseDirection(direction)][color] || []))
                            }

                            // Create Segment for each previous station
                            for (let [prevStationAbbr, estimate] of Object.entries(prevStationEstimates)) {
                                segments.push(polylineForStations([stationLinks[prevStationAbbr], station], reverseDirection(direction), estimate))
                            }
                        }
                    }
                }
                return {stationAbbr, estimates, segments};
            })
            .catch(error => {
                console.log(error);
                return {stationAbbr: stationAbbr, estimates: [], segments: []}
            })
        )
    }

    return Promise.all(stationPromises)
        .then(stationDetails => {return stationDetails.reduce(
            (obj, stationDetail) => {
                stationDetail['marker'] = stationMarkers[stationDetail.stationAbbr];
                addArrivalWindowToMarker(stationDetail.marker, stationDetail.estimates, map);
                obj[stationDetail.stationAbbr] = stationDetail;
                return obj;
            }, {})
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
        return 'yellow';
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
            label: station.abbr,
            position: location,
            map: map
        });
    }

    return stationMarkers;
}

function polylineForStations(stationMarkers, direction, estimate) {
    let locations = stationMarkers.map(marker => marker.position);

    // TODO: Offset locations for direction so that lines appear side by side
    var lineSymbol = {
        path: google.maps.SymbolPath.FORWARD_CLOSED_ARROW,
        scale: 3
    };

    return new google.maps.Polyline({
        path: locations,
        geodesic: true,
        strokeColor: lineColorForEstimate(estimate),
        strokeOpacity: 0.5,
        strokeWeight: 5,
        icons: [{
            icon: lineSymbol,
            offset: '100%'
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
                        <td>${(destination.estimate.map((train) => `<div class="colorbox"
                                                                         style="background-color: ${train.hexcolor}"></div>
                                                                    ${train.minutes}`).join('<br>'))}</td>
                        <td>${(destination.estimate.map((train) => train.delay).join('<br>'))}</td>
                    </tr>
                `)}
            </tbody>
        </table>`;
}

function addArrivalWindowToMarker(marker, estimates, map) {
    if (!estimates) {
        return;
    }

    let infowindow = new google.maps.InfoWindow({
        content: formatStationInfo(marker.title, estimates)
    });

    // TODO: make this work better/smarter
    marker.addListener('click', function() {
        if(!marker.open){
            infowindow.open(map,marker);
            marker.open = true;
        }
        else{
            infowindow.close();
            marker.open = false;
        }
    });

}
