import {retry, pause} from './api_utils.js'

const baseUrl = "https://api.bart.gov/api/";

const defaultParams = {
    json: 'y',
    key: 'MW9S-E7SL-26DU-VV8V'  // Publicly available key
};

const numRetries = 2;


export class BartAPI {
    makeRequest(subApiName, params) {
        Object.assign(params, defaultParams);

        let fullUrl = new URL(`${baseUrl}${subApiName}.aspx`);

        // Add params to URL
        Object.keys(params).forEach(key => fullUrl.searchParams.append(key, params[key]));

        return retry(numRetries, () => {
            return fetch(fullUrl)
                .then(response => response.json())
                .then(data => data.root)
        });
    }

    stationList() {
        return this.makeRequest('stn', {cmd: 'stns'})
            .then(data => data.stations.station)
    }

    stationDetail(stationAbv) {
        return this.makeRequest('stn', {cmd: 'stninfo', orig: stationAbv})
            .then(data => data.stations.station)
    }

    routeList() {
        return this.makeRequest('route', {cmd: 'routes'})
            .then(data => data.routes.route)
    }

    routeDetail(routeNum) {
        return this.makeRequest('route', {cmd: 'routeinfo', route: routeNum})
            .then(data => data.routes.route)
    }

    estimatedDepartures(stationAbv) {
        return this.makeRequest('etd', {cmd: 'etd', orig: stationAbv})
            .then(data => data.station[0].etd)
            .catch(() => {return []})
    }

    advisories() {
        return this.makeRequest('bsa', {cmd: 'bsa'})
            .then(data => data.bsa.reduce((obj, advisory) => {
                obj[advisory.station] = advisory.description['#cdata-section'];
                return obj;
            }, {}));
    }

    routeSchedule(routeNum) {
        return this.makeRequest('sched', {cmd: 'routesched', route: routeNum})
    }
}
