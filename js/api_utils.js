export function retry(retries, fn, delay=500) {
    // Perform retries with exponential backoff
    return fn().catch(err => {
        if (err instanceof SyntaxError) {
            console.log('Bad API response');
            return err;
        } else if (retries > 1) {
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

export function pause(duration) {
    return new Promise(res => setTimeout(res, duration))
}
