
const baseUrl = "https://api.bart.gov/api/";

const defaultParams = {
    json: 'y',
    key: 'MW9S-E7SL-26DU-VV8V'  // Publicly available key
};


export class BartAPI {
    makeRequest(subApiName, params) {
        Object.assign(params, defaultParams);

        let fullUrl = new URL(`${baseUrl}${subApiName}.aspx`);

        // Add params to URL
        Object.keys(params).forEach(key => fullUrl.searchParams.append(key, params[key]));

        return retry(2, () => {
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
}


function retry(retries, fn, delay=500) {
    return fn().catch(err => {
        if (retries > 1) {
            console.log('Retrying API call');
            return pause(delay).then(() => {
                return retry(retries - 1, fn, delay * 2);
            })
        } else {
            console.log('API ran out of retries for call');
            return Promise.reject(err)
        }
    });
}

function pause(duration) {
    return new Promise(res => setTimeout(res, duration))
}
