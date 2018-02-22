import {BartAPI} from './bart_api.js'

var map;
var infoWindow;
var bartapi = new BartAPI();

const refreshRate = 60000 * 3; // mins


$(() => {
    map = initMap(document.getElementById('map'));
    infoWindow = createInfoWindow(map);
    populateMap();
    updateAdvisories();
});

function initMap(element) {
    console.log('Initializing map');
    return new google.maps.Map(element, {
        center: {lat: 37.774836, lng: -122.224175},
        zoom: 10.75,
        zoomControl: true,
        mapTypeControl: false,
        scaleControl: false,
        streetViewControl: false,
        rotateControl: false,
        fullscreenControl: false
    });
}

function populateMap() {
    bartapi.stationList()
        .then(stations => stationListToMarkers(stations))
        .then(stationMarkers => createStationLinks(stationMarkers))
        .then(stationLinks => refreshLoop(stationLinks, refreshRate))
        .catch(error => {
            console.log(error)});
}

function clearSegments(stationDetails) {
    for (let stationDetail of Object.values(stationDetails)) {
        for (let segment of stationDetail.segments) {
            segment.setMap(null);
        }
    }
}

function refreshLoop(stationLinks, delay, stationDetails) {
    console.log('Refreshing delays');
    infoWindow.close();
    if (stationDetails) {clearSegments(stationDetails)}
    createStationDetails(stationLinks)
        .then(stationDetails => {
            setTimeout(() => refreshLoop(stationLinks, delay, stationDetails), delay);
        })
}

function stationListToMarkers(stations) {
    return new Map(stations.map(station => [station.abbr, createMarkerForStation(station)]));
}

function createMarkerForStation(station) {
    let location = new google.maps.LatLng(parseFloat(station.gtfs_latitude), parseFloat(station.gtfs_longitude));

    let marker = new google.maps.Marker({
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

    marker.abbr = station.abbr;
    marker.estimates = null;

    addClickListenerToMarker(marker, map);

    return marker;
}

function createStationLinks(stationMarkers) {
    // Create a map of stations allowing lookup by stationMarker to get north and south connected stations and relevant
    // routes.

    // NOTE: Using routeColor here because it's the only indication of the actual route in the estimated times later.
    // NOTE: Direction can vary by route despite heading in the same physical direction between two stations.

    let stationLinks = new Map();

    return bartapi.routeList()
        .then(routes =>
            routes.map(route =>
                bartapi.routeDetail(route.number)
                    .then(routeDetails => {
                        let prevMarker = null;
                        for (let abbr of routeDetails.config.station) {
                            let stationMarker = stationMarkers.get(abbr);
                            if (prevMarker === null) {
                                prevMarker = stationMarker;
                                continue;  // Skip first one so that we have something to associate
                            }

                            // Ensure structure
                            if (!stationLinks.has(stationMarker)) {
                                stationLinks.set(stationMarker, new Map());
                            }

                            if (!stationLinks.get(stationMarker).has(prevMarker)) {
                                stationLinks.get(stationMarker).set(prevMarker, new Map());
                            }

                            stationLinks.get(stationMarker).get(prevMarker).set(routeDetails.color, routeDetails.direction);

                            prevMarker = stationMarker;
                        }
                    })
            )
        )
        .then(routePromises => Promise.all(routePromises))
        .then(() => stationLinks);
}

function createStationDetails(stationLinks) {
    // For each station, get estimates, figure out which previous station the estimate is from, then generate segments
    let stationPromises = Array.from(stationLinks).map(([stationMarker, links]) =>
        stationDetailsForStationMarker(stationMarker, links));

    return Promise.all(stationPromises)
        .then(stationDetailResults =>
            stationDetailResults.reduce(
                (obj, stationDetail) => {
                    obj[stationDetail.marker.abbr] = stationDetail;
                    return obj;
                }, {})
        );
}

function stationDetailsForStationMarker(stationMarker, links) {
    // For station, get estimates, figure out which previous station the estimate is from, then generate segments
    return bartapi.estimatedDepartures(stationMarker.abbr)
        .then(estimates => {
            let stationDetail = {marker: stationMarker, estimates: estimates, segments: []};
            if (estimates && estimates.length > 0) {
                stationMarker.estimates = estimates; // For infowindow to access the most recent estimates

                let routeDelays = stationEstimatesToRouteDelays(estimates);

                let prevStationDelays = delaysByPrevStation(links, routeDelays);

                stationDetail.segments = segmentsForStation(stationMarker, prevStationDelays);
                for (let segment of stationDetail.segments) {
                    addClickListenerToPolyLine(segment, map);
                }
            }

            return stationDetail;
        })
        .catch(error => {
            console.log(error);
            stationMarker.estimates = null;
            return {marker: stationMarker, estimates: [], segments: []}
        })
}

function stationEstimatesToRouteDelays(estimates) {
    // Collect train delays, ordered by route and direction

    // We don't care about destination
    let allEstimates = [].concat([], ...estimates.map(dest => dest.estimate));

    let routeDelays = new Map();
    for (let trainEst of allEstimates) {
        if (!routeDelays.has(trainEst.color)) {
            routeDelays.set(trainEst.color, new Map([['North', []], ['South', []]]));
        }
        routeDelays.get(trainEst.color).get(trainEst.direction).push(parseInt(trainEst.delay))
    }

    return routeDelays;
}

function delaysByPrevStation(prevStationLinks, routeDelays) {
    // Get average estimate for all trains coming from previous station
    let prevStationDelays = new Map();
    for (let [prevStationMarker, colorDirections] of prevStationLinks.entries()) {
        if (!prevStationDelays.has(prevStationMarker)) {
            prevStationDelays.set(prevStationMarker, []);
        }

        for (let [color, direction] of colorDirections.entries()) {
            if (!routeDelays.has(color)) { continue; }
            let delays = routeDelays.get(color).get(direction);
            prevStationDelays.get(prevStationMarker).push(...delays)
        }
    }

    return prevStationDelays;
}

function segmentsForStation(stationMarker, prevStationDelays) {
    // Create Segment for each previous station
    return Array.from(prevStationDelays).map(([prevStationMarker, delays]) =>
        polylineForStations([prevStationMarker, stationMarker], avgDelay(delays))
    );
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

function lineColorForDelay(delay) {
    if (delay > 30) {
        return 'red';
    } else if (delay > 5) {
        return 'orange';
    } else {
        return 'green';
    }
}

function polylineForStations(startEndMarkers, delay) {
    let locations = startEndMarkers.map(marker => marker.position);

    var lineSymbol = {
        path: google.maps.SymbolPath.FORWARD_OPEN_ARROW,
        scale: 2
    };

    // Cut line between stations at midpoint and set the start point to the midpoint -- this will allow us to see
    // each direction clearly
    let midpoint = middlePoint(locations[0].lat(), locations[0].lng(),
        locations[1].lat(), locations[1].lng());

    let newStart = new google.maps.LatLng(midpoint[0], midpoint[1]);

    let line = new google.maps.Polyline({
        path: [newStart, locations[1]],
        geodesic: true,
        strokeColor: lineColorForDelay(delay),
        strokeOpacity: 1,
        strokeWeight: 5,
        icons: [{
            icon: lineSymbol,
            repeat: '20px'
        }],
        map: map
    });

    line.startEndMarkers = startEndMarkers;
    line.delay = delay;

    return line;
}

function generateStationMarkerEstimatesDisplay(marker) {
    if (marker && marker.title && marker.estimates) {
        return `
            <h5>${marker.title}</h5>
            <table class="table">
                <thead>
                    <tr>
                        <th scope="col">Destination</th>
                        <th scope="col"></th>
                        <th scope="col">ETA</th>
                        <th scope="col">Delay</th>
                    </tr>
                </thead>
                <tbody>
                    ${marker.estimates.map((destination) => `
                        <tr>
                            <td>${destination.destination}</td>
                            <td>${destination.estimate.map((train) => `<div class="colorbox"
                                                                             style="background-color: ${train.hexcolor}"></div>`).join('<br>')}</td>
                            <td class="text-right">${destination.estimate.map((train) => estUnitsText(train.minutes)).join('<br>')}</td>
                            <td class="text-right">${destination.estimate.map((train) => estUnitsText(train.delay)).join('<br>')}</td>
                        </tr>
                    `).join('')}
                </tbody>
            </table>`;
    } else {
        return `<h5>${marker.title || 'Unknown Station'}</h5>
                <span>No estimates available.</span>`
    }
}

function generateSegmentDelayDisplay(polyline) {
    if (polyline && !isNaN(polyline.delay)) {
        return `<span>Avg delay from ${polyline.startEndMarkers[0].title} to ${polyline.startEndMarkers[1].title} is ${estUnitsText(polyline.delay)}</span>`
    } else {
        return `<span>No estimates available from ${polyline.startEndMarkers[0].title} to ${polyline.startEndMarkers[1].title}</span>`
    }
}

function addClickListenerToMarker(marker, map) {
    // Only attach when we've created new markers, or we'll end up with duplicate listeners
    marker.addListener('click', () => {
        infoWindow.setContent(generateStationMarkerEstimatesDisplay(marker));
        infoWindow.open(map, marker);
    });
}

function addClickListenerToPolyLine(polyline, map) {
    // Because we throw away polylines everytime we update, attach every time we refresh them
    polyline.addListener('click', (e) => {
        infoWindow.setContent(generateSegmentDelayDisplay(polyline));
        infoWindow.setPosition(e.latLng);
        infoWindow.open(map);
    });
}

function createInfoWindow(map) {
    infoWindow = new google.maps.InfoWindow({content: ''});
    map.addListener('click', () => {
        infoWindow.close();
    });
    return infoWindow;
}

function estUnitsText(estimate) {
    let parsedInt = parseInt(estimate);
    if (isNaN(parsedInt)) {
        return estimate;
    } else if (parsedInt === 1) {
        return '1 min';
    } else {
        return `${Math.round(estimate)} mins`;
    }
}

function updateAdvisories() {
    bartapi.advisories()
        .then(advisories => {
            let advisoryText = advisories[''];
            console.log(`Advisory text: ${advisoryText}`);
            let $advisoryTextBox = $('#advisoryText');
            if (advisoryText === 'No delays reported.') {
                $advisoryTextBox.html('');
            } else {
                $advisoryTextBox.html(advisoryText);
            }
        })
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
