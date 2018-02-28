import {BartAPI} from './bart_api.js'

var bartapi = new BartAPI();

const refreshRate = 60000 * 3; // mins
const hiddenCheckRate = 10000; // secs -- when it's past time to refresh, check if we're still hidden this often to give
                               //         a relatively quick update when the user comes back.


$(() => {
    let map = initMap(document.getElementById('map'));
    let infoWindow = createInfoWindow(map);
    populateMap(map, infoWindow);
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

function populateMap(map, infoWindow) {
    bartapi.stationList()
        .then(stations => stationListToMarkers(stations))
        .then(stationMarkers => displayStationMarkers(stationMarkers, map))
        .then(stationMarkers => addClickListenerToMarkers(stationMarkers, map, infoWindow))
        .then(stationMarkers => createStationLinks(stationMarkers))
        .then(stationLinks => refreshLoop(stationLinks, refreshRate, map, infoWindow))
        .catch(error => {
            console.log(error)});
}

function displayStationMarkers(items, map) {
    for (let item of items.values())
        item.setMap(map);
    return items;
}

function clearSegments(stationDetails) {
    for (let stationDetail of Object.values(stationDetails)) {
        for (let segment of stationDetail.segments) {
            segment.setMap(null);
        }
    }
}

function refreshLoop(stationLinks, delay, map, infoWindow, stationDetails) {
    if (document.hidden) {
        console.log('Page is hidden, skipping refresh and checking back soon');
        setTimeout(() => refreshLoop(stationLinks, delay, map, infoWindow, stationDetails), hiddenCheckRate)
    } else {
        console.log('Refreshing delays');
        if (stationDetails) {clearSegments(stationDetails)}
        updateAdvisories();
        createStationDetails(stationLinks, map, infoWindow)
            .then(stationDetails => {
                setTimeout(() => refreshLoop(stationLinks, delay, map, infoWindow, stationDetails), delay);
            })
    }
}

function stationListToMarkers(stations) {
    return new Map(stations.map(station => [station.abbr, createMarkerForStation(station)]));
}

function createMarkerForStation(station) {
    let location = new google.maps.LatLng(parseFloat(station.gtfs_latitude), parseFloat(station.gtfs_longitude));

    let marker = new google.maps.Marker({
        title: station.name,
        position: location,
        opacity: 0.5,
        icon: {
            path: google.maps.SymbolPath.CIRCLE,
            scale: 6,
            strokeColor: 'blue'
        }
    });

    marker.abbr = station.abbr;
    marker.estimates = null;

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

function createStationDetails(stationLinks, map, infoWindow) {
    console.log('Generating station layout');

    // For each station, get estimates, figure out which previous station the estimate is from, then generate segments
    let stationPromises = Array.from(stationLinks).map(([stationMarker, links]) =>
        stationDetailsForStationMarker(stationMarker, links, map, infoWindow));

    return Promise.all(stationPromises)
        .then(stationDetailResults =>
            stationDetailResults.reduce(
                (obj, stationDetail) => {
                    obj[stationDetail.marker.abbr] = stationDetail;
                    return obj;
                }, {})
        );
}

function stationDetailsForStationMarker(stationMarker, links, map, infoWindow) {
    // For station, get estimates, figure out which previous station the estimate is from, then generate segments
    return bartapi.estimatedDepartures(stationMarker.abbr)
        .then(estimates => {
            let stationDetail = {marker: stationMarker, estimates: estimates, segments: []};
            if (estimates && estimates.length > 0) {
                stationMarker.estimates = estimates; // For infowindow to access the most recent estimates

                let routeDelays = stationEstimatesToRouteDelays(estimates);

                let prevStationDelays = delaysByPrevStation(links, routeDelays);

                stationDetail.segments = segmentsForStation(stationMarker, prevStationDelays, map, infoWindow);
                addClickListenerToPolyLines(stationDetail.segments, map, infoWindow);
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

function segmentsForStation(stationMarker, prevStationDelays, map, infoWindow) {
    // Create Segment for each previous station
    return Array.from(prevStationDelays).map(([prevStationMarker, delays]) =>
        polylineForStations([prevStationMarker, stationMarker], avgDelay(delays), map, infoWindow)
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

function polylineForStations(startEndMarkers, delay, map) {
    let locations = startEndMarkers.map(marker => marker.position);

    let angle = angleBetweenCoordinates(locations[0].lat(), locations[0].lng(),
                                        locations[1].lat(), locations[1].lng());
    let offsetStart = offsetPoint(locations[0].lat(), locations[0].lng(), 0.001, angle + 90);
    let offsetEnd = offsetPoint(locations[1].lat(), locations[1].lng(), 0.001, angle + 90);

    let newStart = new google.maps.LatLng(...offsetStart);
    let newEnd = new google.maps.LatLng(...offsetEnd);

    let line = new google.maps.Polyline({
        path: [newStart, newEnd],
        geodesic: true,
        strokeColor: lineColorForDelay(delay),
        strokeOpacity: 1,
        strokeWeight: 5,
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

function addClickListenerToMarkers(markers, map, infoWindow) {
    for (let marker of markers.values()) {
        addClickListenerToMarker(marker, map, infoWindow);
    }
    return markers;
}

function addClickListenerToMarker(marker, map, infoWindow) {
    // Only attach when we've created new markers, or we'll end up with duplicate listeners
    marker.addListener('click', () => {
        infoWindow.setContent(generateStationMarkerEstimatesDisplay(marker));
        infoWindow.open(map, marker);
    });
}

function addClickListenerToPolyLines(polylines, map, infoWindow) {
    for (let line of polylines) {
        addClickListenerToPolyLine(line, map, infoWindow);
    }
    return polylines;
}

function addClickListenerToPolyLine(polyline, map, infoWindow) {
    // Because we throw away polylines everytime we update, attach every time we refresh them
    polyline.addListener('click', (e) => {
        infoWindow.setContent(generateSegmentDelayDisplay(polyline));
        infoWindow.setPosition(e.latLng);
        infoWindow.open(map);
    });
}

function createInfoWindow(map) {
    let infoWindow = new google.maps.InfoWindow({content: ''});
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
    console.log('Updating system advisories');
    bartapi.advisories()
        .then(advisories => {
            let advisoryText = advisories[''];
            console.log(`Advisory text: ${advisoryText}`);
            let $advisoryTextBox = $('#advisory-text');
            if (advisoryText === 'No delays reported.') {
                $advisoryTextBox.html('');
            } else {
                $advisoryTextBox.html(advisoryText);
            }
        })
}

function toRad(num) {
    return num * Math.PI / 180;
}

function toDeg(num) {
    return num * (180 / Math.PI);
}

function angleBetweenCoordinates(lat1, lng1, lat2, lng2) {
    let diffLat = lat2 - lat1;
    let diffLng = lng2 - lng1;
    let theta = Math.atan2(diffLng, diffLat);  // in radians
    return toDeg(theta);
}

function averageAngle(angle1, angle2) {
    return ((angle2 + angle1) % 360) / 2;
}

function averageAngles(angle1, angle2) {
    // Get both representations of angle of line that passes through the average angle
    let avgAngle = averageAngle(angle1, angle2);
    return [avgAngle, 180-avgAngle];
}

function offsetPoint(lat, lng, distance, angle) {
    let radAngle = toRad(angle);
    let x = distance * Math.sin(radAngle);
    let y = distance * Math.cos(radAngle);
    return [lat + y, lng + x];
}

function mapPositionToPixels(position, map) {
    let projection = map.getProjection();
    let bounds = map.getBounds();
    let topRight = projection.fromLatLngToPoint(bounds.getNorthEast());
    let bottomLeft = projection.fromLatLngToPoint(bounds.getSouthWest());
    let scale = Math.pow(2, map.getZoom());
    let worldPoint = projection.fromLatLngToPoint(position);
    return [Math.floor((worldPoint.x - bottomLeft.x) * scale), Math.floor((worldPoint.y - topRight.y) * scale)];
}

