const MODE = {
    FAST_CONVERGENCE: 0,
    MAX_PROBING: 1
};


export class BandwidthOptimizer {

    static FALLBACK_FLIGHT = 3000; // for when this is disabled
    static MIN_FLIGHT = 1500;
    static MAX_FLIGHT = 30000;

    #
    intervalId;

    // A backoff condition variable, deviation allowed by the current frame compared to the cwnd
    // see BandwidthOptimizer.hasCongestionEvent
    CWND_DEVIATION = 30;

    // Cubic TCP variables
    // BETA is the congestion multiplicative decrease factor. The standard defines it at 0.7, but
    // we are slow to explore the bandwidth because of the large batch sizes and the long sampling
    // interval, so this is at 0.8 to more quickly regain bandwidth
    BETA = 0.8;
    // Fast convergence should not be 1-BETA like recommended, the sample rate is too slow to regain quickly
    FAST_CONVERGENCE = 0.7;
    wMax = 0; // Byte throughput right before last congestion event
    lastReductionTs = performance.now(); // Last congestion
    // This is the scaling constant which adjust the agressiveness of the curve (along with polynomial)
    // on higher latency systems, this should be lower. Potentially could track RTT and scale it accordingly
    // Note: the standard recommends 0.4 but I lowered it to make the curve a little more gradual
    SCALING = 0.25;
    cwnd = 0; // Realtime flight size in bytes throughput using asset size estimate

    // In the case of network timeouts, failures, or high congestion we need a fallback to use for asset estimation
    initialAssetEstimate;

    #
    currentFlightSize = 0;

    // Would be nice to sample at a faster rate but VDS prefers sending larger batches
    #
    SAMPLE_INTERVAL = 1000;

    // For evaluating the congestion window
    // Each node should have data attached to it about the last time window
    //   - Throughput
    //   - Flight size
    //   - Average asset size
    #
    frameTracker = new FlightTracker(1000);
    // Timeout tracker - retains 20 samples, 10 for timeout and 10 for storing "last good cwnd/flight count" for waking up
    #
    timeoutTracker = new FlightTracker(20);
    wasReset = false;

    #
    frameRxStats = {
        count: 0,
        totalBytes: 0
    };


    constructor(currentInFlight, initialAssetEstimate, avgBytesSec, onFlightSizeUpdated) {
        this.onFlightSizeUpdated = onFlightSizeUpdated;

        // manually calculate the initial state
        this.#currentFlightSize = currentInFlight;
        this.#frameRxStats.totalBytes = avgBytesSec;
        this.#frameRxStats.count = currentInFlight;
        this.initialAssetEstimate = initialAssetEstimate;

        this.wMax = this.#frameRxStats.totalBytes;
        this.cwnd = this.wMax * this.BETA;

        this.#onNextFrame();
        this.#sample();
    }


    /**
     * Get the expected relative throughput increase
     * If deviates more than X amount from expected then it's a congestion event
     *
     * Note: the comparison isn't between the previous and current frame, the comparison is
     * between the starting CWND (last congestion event) and the current frame, so it is quite permissive
     */
    hasCongestionEvent() {
        // this is checked after the current frame is pushed, so technically we only require looking behind 2 frames: a congestion and an increase step
        if (this.#frameTracker.count < 3) return false;

        const currentFrame = this.#frameTracker.tail.data;
        const lastCongestionEvent = this.#frameTracker.head.data;

        if (this.cwnd < currentFrame.receivedBytes) return false;

        const increase = currentFrame.receivedBytes / (lastCongestionEvent.receivedBytes || 1);

        if (increase < 1) {
            return true;
        }

        const expectedIncrease = this.deviation(this.cwnd, lastCongestionEvent.cwnd);
        const actualIncrease = this.deviation(currentFrame.receivedBytes, lastCongestionEvent.receivedBytes);

        return Math.abs(expectedIncrease - actualIncrease) > this.CWND_DEVIATION;
    }


    /**
     * check for 10 complete frames with 0 received... this could accidentally trigger in case of network timeouts,
     * but the only thing that will happen is the flight count reset to the default
     */
    shouldTimeout() {
        if (this.#timeoutTracker.count < this.#timeoutTracker.MAX_SIZE / 2) return false;

        let frame = this.#timeoutTracker.tail || this.#timeoutTracker.head,
            i = 0;
        while (frame && i++ < this.#timeoutTracker.MAX_SIZE / 2) {
            if (frame.data.receivedCount > 0) return false;
            frame = frame.prev;
        }
        return i >= this.#timeoutTracker.MAX_SIZE / 2;
    }


    getMode() {
        return this.cwnd > this.wMax ? MODE.MAX_PROBING : MODE.FAST_CONVERGENCE;
    }


    #
    sample() {
        if (this.shouldTimeout()) {
            this.onFlightSizeUpdated(BandwidthOptimizer.FALLBACK_FLIGHT);
            clearInterval(this.#intervalId);
            this.#reset();
            return;
        }

        const thisFrame = this.#onNextFrame();

        // single frame average is not very reliable... use last 3 samples
        let i = 0,
            totalBytes = 0,
            count = 0;
        for (let {
                data
            } of this.#timeoutTracker) {
            if (i++ === 3) break;
            totalBytes += data.receivedBytes;
            count += data.receivedCount;
        }

        const averageSize = totalBytes / count || thisFrame.fragmentSize;

        let newCwndBytes;

        const mb = it => it / 1 _000_000;
        // evaluate cubic tcp
        const K = Math.cbrt(
            (mb(this.wMax) * (1 - this.BETA)) / this.SCALING
        );
        const T = (performance.now() - this.lastReductionTs) / 1000;
        newCwndBytes = this.cwnd = ((this.SCALING * Math.pow((T - K), 3)) + mb(this.wMax)) * 1 _000_000;

        if (this.hasCongestionEvent()) {
            const multiplier = this.getMode() === MODE.MAX_PROBING ? this.BETA : this.FAST_CONVERGENCE;

            this.lastReductionTs = performance.now();
            this.wMax = this.#frameTracker.tail.prev.data.receivedBytes;
            this.#frameTracker.clear();

            // multiplicative decrease
            newCwndBytes = multiplier * this.wMax;
        }

        let newFlightSize = Math.round(newCwndBytes / averageSize);

        // forcing really slow connections will make it oscillate down to only a hundred fragments or so, but just to be safe and to keep
        // erroring on the side of too many, have a soft limit at 1500 and upper limit of 30K. The test models I've been using max at around 10K bytes
        // per fragment at the start so that's 300Mb at once which is more than enough
        this.#currentFlightSize = newFlightSize = Math.min(BandwidthOptimizer.MAX_FLIGHT, Math.max(BandwidthOptimizer.MIN_FLIGHT, newFlightSize));

        this.onFlightSizeUpdated(newFlightSize);
    }

    #
    reset() {

        let totalCwnd = 0,
            i = 0;
        for (let {
                data
            } of this.#timeoutTracker) {
            if (i++ < this.#timeoutTracker.MAX_SIZE / 2) continue; // skip the empty timed-out frames
            totalCwnd += data.cwnd;
        }
        const avgCwnd = totalCwnd / this.#timeoutTracker.count;

        this.wMax = avgCwnd * (1 + (1 - this.BETA));
        this.cwnd = avgCwnd;
        this.#frameTracker.clear();
        this.#timeoutTracker.clear();
        this.wasReset = true;
    }

    /**
     * Resets the frame state variables. Returns the estimate for the next frame
     */
    #
    onNextFrame() {

        // protect against divide by zero
        const lastKnownFragmentSize = this.#frameRxStats.count && this.#frameRxStats.totalBytes ?
            this.#frameRxStats.totalBytes / this.#frameRxStats.count :
            (this.#frameTracker.tail || this.#frameTracker.head) ? .data.fragmentSize ||
            this.initialAssetEstimate;

        const thisFrame = {
            fragmentSize: lastKnownFragmentSize,
            receivedCount: this.#frameRxStats.count,
            receivedBytes: this.#frameRxStats.totalBytes,
            cwnd: this.cwnd
        };

        this.#frameTracker.onReceived(thisFrame);
        this.#timeoutTracker.onReceived(thisFrame);

        this.#frameRxStats.count = 0;
        this.#frameRxStats.totalBytes = 0;

        return thisFrame;
    }

    /**
     * @param count Asset count
     * @param byteSize The size of the resource
     */
    onResourceReceived(count, byteSize) {
        this.#frameRxStats.totalBytes += byteSize;
        this.#frameRxStats.count += count;

        if (this.wasReset) {
            this.wasReset = false;
            this.lastReductionTs = performance.now();
            this.#intervalId = setInterval(() => {
                this.#sample();
            }, this.#SAMPLE_INTERVAL);
        }
    }

    deviation(a, b) {
        const delta = Math.abs(a - b);
        const average = (a + b) / 2;
        return (delta / average) * 100;
    }


    static createAndStart(currentInFlight, initialAssetEstimate, avgBytesSec, onFLightSizeUpdated) {
        const instance = new BandwidthOptimizer(currentInFlight, initialAssetEstimate, avgBytesSec, onFLightSizeUpdated || (() => {}));

        instance.#intervalId = setInterval(() => {
            instance.#sample();
        }, instance.#SAMPLE_INTERVAL);

        return instance;
    }
}


class FlightTracker {
    MAX_SIZE = 2000;

    #
    count = 0;
    totalBytes = 0;
    head;
    tail;

    get count() {
        return this.#count;
    }

    constructor(MAX_SIZE = 2000, trimEval = (head, tail) => this.count > this.MAX_SIZE) {
        this.MAX_SIZE = MAX_SIZE;
        this.trimEval = trimEval;
    }

    clear() {
        this.#count = 0;
        this.totalBytes = 0;
        this.head = null;
        this.tail = null;
    }

    // most recent at the end
    onReceived(data, count) {
        this.addNode(new ListNode(data), count);
    }

    addNode(node, count = 1) {
        if (this.#count === 0) {
            this.head = node;
        } else if (this.#count === 1) {
            this.tail = node;
            this.head.setNext(node);
        } else {
            this.tail.setNext(node);
            this.tail = node;
        }
        this.#count += count;
        while (this.trimEval(this.head, this.tail)) {
            const newHead = this.head.next;
            this.head.unlink();
            this.totalBytes -= this.head.size;
            this.#count -= (this.head.data ? .count || 1);
            this.head = newHead;
        }
        this.totalBytes += node.size;
    }

}
FlightTracker.prototype[Symbol.iterator] = function*() {
    let current = this.tail;
    while (current) {
        yield current;
        current = current.prev;
    }
};



class ListNode {

    data;
    size = 0;
    prev;
    next;
    timestamp;

    constructor(data) {
        this.data = data;
        if (data.size) {
            this.size = data.size;
        }
        this.timestamp = Date.now();
    }

    setNext(n) {
        this.next = n;
        if (n) {
            this.next.prev = this;
        }
        return this;
    }

    setPrev(n) {
        this.prev = n;
        if (n) {
            this.prev.next = this;
        }
        return this;
    }

    unlink() {
        this.prev ? .setNext(this.next);
        this.next ? .setPrev(this.prev);
        this.prev = null;
        this.next = null;
    }
}