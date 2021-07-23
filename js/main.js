import {BartAPI} from './bart_api.js'

var bartapi = new BartAPI();

const refreshRate = 60000 * 3; // mins
const hiddenCheckRate = 5 * 1000; // secs -- when it's past time to refresh, check if we're still hidden this often to give
                                  //         a relatively quick update when the user comes back.

const scheduleTimeRegex = new RegExp('^(\\d{1,2}):(\\d{1,2})\\s(AM|PM)$');


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
        .then(stationMarkers => displayMarkerValues(stationMarkers, map))
        .then(stationMarkers => addClickListenerToStationMarkers(stationMarkers, map, infoWindow))
        .then(stationMarkers => createStationLinks(stationMarkers))
        .then(stationLinks => refreshTrafficLoop(stationLinks, refreshRate, map, infoWindow))
        .then(() => showScheduledTrains(map, infoWindow))
        .catch(error => {
            console.log(error)});


}

function showScheduledTrains(map, infoWindow) {
    return Promise.all([getAllActiveRouteNums().then(routeNums => getSchedulesForRouteNums(routeNums)),
            bartapi.stationList().then(stations => stationListToMarkers(stations))])
        .then(([routeSchedules, stationMarkers]) => refreshTrainPositionLoop(routeSchedules, stationMarkers, map, infoWindow))
}

function displayMarkerValues(markers, map) {
    displayMarkers(markers.values(), map);
    return markers;
}

function displayMarkers(markers, map) {
    for (let item of markers)
        item.setMap(map);
    return markers;
}

function clearSegments(stationDetails) {
    for (let stationDetail of Object.values(stationDetails)) {
        for (let segment of stationDetail.segments) {
            segment.setMap(null);
        }
    }
}

function refreshTrafficLoop(stationLinks, delay, map, infoWindow, stationDetails) {
    if (document.hidden) {
        setTimeout(() => refreshTrafficLoop(stationLinks, delay, map, infoWindow, stationDetails), hiddenCheckRate)
    } else {
        console.log('Refreshing delays');
        if (stationDetails) {clearSegments(stationDetails)}
        updateAdvisories();
        createStationDetails(stationLinks, map, infoWindow)
            .then(stationDetails => {
                setTimeout(() => refreshTrafficLoop(stationLinks, delay, map, infoWindow, stationDetails), delay);
            })
    }
}

function refreshTrainPositionLoop(routeSchedules, stationMarkers, map, infoWindow, trainMarkers) {
    if (document.hidden) {
        setTimeout(() => refreshTrainPositionLoop(routeSchedules, stationMarkers, map, infoWindow, trainMarkers), hiddenCheckRate);
    } else {
        //console.log('Refreshing train positions');
        let progressions = getAllTrainsProgressForSchedules(routeSchedules, new Date());
        trainMarkers = updateTrainMarkers(progressions, stationMarkers, trainMarkers, map, infoWindow);
        setTimeout(() => refreshTrainPositionLoop(routeSchedules, stationMarkers, map, infoWindow, trainMarkers), 1000)
    }
}

function stationListToMarkers(stations) {
    return new Map(stations.map(station => [station.abbr, createMarkerForStation(station)]));
}

function createMarkerForStation(station) {
    let position = new google.maps.LatLng(parseFloat(station.gtfs_latitude), parseFloat(station.gtfs_longitude));

    let marker = new google.maps.Marker({
        title: station.name,
        position: position,
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
                    }).catch(() => undefined)
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
    if (delays && delays.length) {
        return delays.reduce((total, num) => total + num) / delays.length;
    } else {
        return 0
    }
}

function lineColorForDelay(delay) {
    let delayMins = delay / 60;
    if (delayMins > 30) {
        return 'black';
    } else if (delayMins > 10) {
        return 'red';
    } else if (delayMins > 5) {
        return 'orange';
    } else if (delayMins > 1) {
        return 'gold';
    } else {
        return 'green';
    }
}

function polylineForStations(startEndMarkers, delay, map) {
    let positions = startEndMarkers.map(marker => marker.position);

    let angle = angleBetweenCoordinates(positions[0].lat(), positions[0].lng(),
                                        positions[1].lat(), positions[1].lng());
    let offsetStart = offsetPoint(positions[0].lat(), positions[0].lng(), 0.001, angle + 90);
    let offsetEnd = offsetPoint(positions[1].lat(), positions[1].lng(), 0.001, angle + 90);

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
                            <td class="text-right">${destination.estimate.map((train) => delayUnitsText(train.delay)).join('<br>')}</td>
                        </tr>
                    `).join('')}
                </tbody>
            </table>`;
    } else {
        return `<h5>${marker.title || 'Unknown Station'}</h5>
                <span>No estimates available.</span>`
    }
}

function generateTrainMarkerInfoDisplay(marker) {
    if (marker && marker.title && marker.destStation) {
        return `
            <h5>${marker.destStation.title} Train <small>(Scheduled)</small></h5>
            <span>Train Origin: ${marker.title}</span><br>
            <span>Avg Segment Speed: ${Math.round(calcSpeed(marker.prevPosition, marker.position, 1))} MPH</span>`;
    } else {
        return `<h6>Train Origin: ${marker.title || 'Unknown'}</h6>`
    }
}

function generateSegmentDelayDisplay(polyline) {
    if (polyline && !isNaN(polyline.delay)) {
        return `<span>Avg delay from ${polyline.startEndMarkers[0].title} to ${polyline.startEndMarkers[1].title} is ${delayUnitsText(polyline.delay)}</span>`
    } else {
        return `<span>No estimates available from ${polyline.startEndMarkers[0].title} to ${polyline.startEndMarkers[1].title}</span>`
    }
}

function addClickListenerToStationMarkers(markers, map, infoWindow) {
    for (let marker of markers.values()) {
        addClickListenerToStationMarker(marker, map, infoWindow);
    }
    return markers;
}

function addClickListenerToStationMarker(marker, map, infoWindow) {
    // Only attach when we've created new markers, or we'll end up with duplicate listeners
    marker.addListener('mouseover', () => {
        infoWindow.setContent(generateStationMarkerEstimatesDisplay(marker));
        infoWindow.open(map, marker);
    });
}

function addClickListenerToTrainMarkers(markers, map, infoWindow) {
    for (let marker of markers.values()) {
        addClickListenerToTrainMarker(marker, map, infoWindow);
    }
    return markers;
}

function addClickListenerToTrainMarker(marker, map, infoWindow) {
    // Only attach when we've created new markers, or we'll end up with duplicate listeners
    marker.addListener('mouseover', () => {
        infoWindow.setContent(generateTrainMarkerInfoDisplay(marker));
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
    polyline.addListener('mouseover', (e) => {
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

function delayUnitsText(delay) {
    let parsedInt = parseInt(delay);
    if (isNaN(parsedInt)) {
        return delay;
    } else {
        let text = `On time`;
        if (parsedInt > 0) {
            // Hours, minutes and seconds
            let hrs = Math.floor(parsedInt / 3600);
            let mins = Math.floor((parsedInt % 3600) / 60);
            let secs = Math.floor(parsedInt % 60);

            let textParts = [];
            if (hrs) {
                textParts.push(`${hrs} hours`)
            }
            if (mins) {
                textParts.push(`${mins} mins`)
            }
            if (secs) {
                textParts.push(`${secs} secs`)
            }
            text = textParts.join(', ')
        }

        return text;
    }
}

function updateAdvisories() {
    console.log('Updating system advisories');
    bartapi.advisories()
        .then(advisories => {
            let advisoryText = advisories[''] || advisories['BART'];
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

function distanceBetweenCoordinates(lat1, lng1, lat2, lng2) {
    let lats = lat2 - lat1;
    let lngs = lng2 - lng1;

    lats *= lats;
    lngs *= lngs;

    return Math.sqrt(lats + lngs);
}

function angleBetweenCoordinates(lat1, lng1, lat2, lng2) {
    let diffLat = lat2 - lat1;
    let diffLng = lng2 - lng1;
    let theta = Math.atan2(diffLng, diffLat);  // in radians
    return toDeg(theta);
}

function offsetPoint(lat, lng, distance, angle) {
    let radAngle = toRad(angle);
    let x = distance * Math.sin(radAngle);
    let y = distance * Math.cos(radAngle);
    return [lat + y, lng + x];
}

function trainProgressForSchedule(trainId, details, now) {
    // return stations that train should be between right now, based on the schedule, and progress between them.
    // if train hasn't started yet, or has completed its route, returns null stations and progress

    let fromStationAbbr = null;
    let fromStationTime = null;

    for (let stop of details.stops) {
        let progress = null;

        // Skip over first station, stations without timing, or stations train has already passed
        if (!fromStationTime || !stop.origTime || stop.origTime < now) {
            fromStationAbbr = stop.stationAbbr;
            fromStationTime = stop.origTime;
            continue;
        } else if (fromStationTime > now && stop.origTime > now) {
            // Route hasn't started yet
            break;
        }

        // determine progress
        let totalDuration = stop.origTime - fromStationTime;
        if (totalDuration > 45 * 60 * 1000) {  // filter out trains with extreme durations (> 45 mins)
            break;
        }
        let currentDuration = now - fromStationTime;
        progress = currentDuration / totalDuration;

        return {trainId, fromStationAbbr, toStationAbbr: stop.stationAbbr, progress, details}
    }

    // Must have finished route
    return {trainId: trainId, fromStationAbbr: null, toStationAbbr: null, progress: null, details}
}

function parseScheduleTime(timeString) {
    // BART days change at ~3AM, not at midnight

    if (!timeString)
        return null;

    let [_, hours, minutes, ampm] = timeString.match(scheduleTimeRegex);

    hours = parseInt(hours);
    minutes = parseInt(minutes);

    if (ampm === 'PM') { hours += 12 }

    let date = new Date();
    date.setHours(hours % 24, minutes, 0, 0);
    return date;
}

function markerForTrainPosition(trainId, fromStationMarker, toStationMarker, progress, destStationMarker, map, infoWindow) {
    return createMarkerForTrain(
            trainId, destStationMarker, ...calculateTrainMarkerPosition(fromStationMarker, toStationMarker, progress
        ), map, infoWindow);
}

function calculateTrainMarkerPosition(fromStationMarker, toStationMarker, progress) {
    let angle = angleBetweenCoordinates(fromStationMarker.position.lat(), fromStationMarker.position.lng(),
        toStationMarker.position.lat(), toStationMarker.position.lng());
    let totalDistance = distanceBetweenCoordinates(fromStationMarker.position.lat(), fromStationMarker.position.lng(),
        toStationMarker.position.lat(), toStationMarker.position.lng());

    let [lat, lng] = offsetPoint(fromStationMarker.position.lat(), fromStationMarker.position.lng(),
        totalDistance * progress, angle);

    return offsetPoint(lat, lng, 0.001, angle + 90);
}

function createMarkerForTrain(trainId, destStationMarker, lat, lng, map, infoWindow) {
    let position = new google.maps.LatLng(lat, lng);

    let marker = new google.maps.Marker({
        title: `${trainId}`,
        position: position,
        opacity: 1,
        icon: {
            path: google.maps.SymbolPath.CIRCLE,
            scale: 3,
            strokeColor: 'red'
        },
        map: map
    });

    marker.destStation = destStationMarker;
    marker.prevPosition = position;

    addClickListenerToTrainMarker(marker, map, infoWindow);

    return marker;
}

function updateTrainMarkerPosition(marker, fromStationMarker, toStationMarker, progress) {
    let position = calculateTrainMarkerPosition(fromStationMarker, toStationMarker, progress);
    marker.prevPosition = marker.position;
    marker.setPosition(new google.maps.LatLng(...position));
}

function getAllActiveRouteNums() {
    return bartapi.routeList()
        .then(routes =>
            routes.map(route => parseInt(route.number)))
}

function getSchedulesForRouteNums(routeNums) {
    return Promise.all(routeNums.map(routeNum => bartapi.routeSchedule(routeNum)
                                                    .then(schedule => parseScheduleTimes(schedule))));
}

function trainsProgressForSchedule(schedule, now) {
    // Collects progress for all trains on route
    return Array.from(schedule).map(([trainId, details]) => trainProgressForSchedule(trainId, details, now))
}

function getAllTrainsProgressForSchedules(routeSchedules, now) {
    return routeSchedules.reduce((result, schedule) => {
        result.push(...trainsProgressForSchedule(schedule, now));
        return result;
    }, [])
}

function updateTrainMarkers(trainProgressions, stationMarkers, existingTrainMarkers, map, infoWindow) {
    existingTrainMarkers = existingTrainMarkers || new Map();

    for (let trainProgress of trainProgressions) {
        if (existingTrainMarkers.has(trainProgress.trainId)) {
            if (trainProgress.toStationAbbr) {
                // train exists and is active, update existing marker position
                updateTrainMarkerPosition(
                    existingTrainMarkers.get(trainProgress.trainId),
                    stationMarkers.get(trainProgress.fromStationAbbr),
                    stationMarkers.get(trainProgress.toStationAbbr),
                    trainProgress.progress
                )
            } else {
                // if progress doesn't have next station, delete the train
                existingTrainMarkers.get(trainProgress.trainId).setMap(null);
                existingTrainMarkers.delete(trainProgress.trainId);
            }
        } else {
            // if active train doesn't exist in existing markers, create it
            if (trainProgress.toStationAbbr) {
                existingTrainMarkers.set(
                    trainProgress.trainId,
                    markerForTrainPosition(
                        trainProgress.trainId,
                        stationMarkers.get(trainProgress.fromStationAbbr),
                        stationMarkers.get(trainProgress.toStationAbbr),
                        trainProgress.progress,
                        stationMarkers.get(trainProgress.details.destStationAbbr),
                        map,
                        infoWindow
                    )
                )
            }
        }
    }

    return existingTrainMarkers;
}

function parseScheduleTimes(schedule) {
    let parsedSchedule = new Map();
    if (schedule.hasOwnProperty('route') && schedule.route.hasOwnProperty('train') && schedule.route.train !== '') {
        for (let train of schedule.route.train) {
            parsedSchedule.set(`${train.stop[0]['@station']}-${train.stop[0]['@origTime']}`,
                {
                    destStationAbbr: train.stop[train.stop.length-1]['@station'],
                    stops: train.stop.map(stop => {
                        return {
                            stationAbbr: stop['@station'],
                            load: parseInt(stop['@load']),
                            level: stop['@level'],
                            origTime: parseScheduleTime(stop['@origTime']),
                            bikeFlag: Boolean(stop['@bikeFlag'])
                        }
                    })
                })
        }
    }

    return parsedSchedule;
}

function easeInOutQuad(percent) {
    if ((percent / 2) < 1)  // In first half of motion
        return 1 / 2 * percent * percent;
    return -1 / 2 * ((--percent) * (percent - 2) - 1);
}

function calcSpeed(position1, position2, periodSecs) {
    // uses haversine formula
    let lat1 = toRad(position1.lat());
    let lng1 = toRad(position1.lng());
    let lat2 = toRad(position2.lat());
    let lng2 = toRad(position2.lng());
    
    let dlon = lng2 - lng1;
    let dlat = lat2 - lat1;
    let a = Math.pow(Math.sin(dlat / 2), 2) + Math.cos(lat1) * Math.cos(lat2) * Math.pow(Math.sin(dlon / 2), 2);
    let c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a)); // great circle distance in radians
    let distance = 3961 * c;  // miles

    return distance / periodSecs * 60 * 60;
}
