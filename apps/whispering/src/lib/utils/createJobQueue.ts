export const createJobQueue = <T extends Promise<unknown>>() => {
	const queue: T[] = [];

	let isProcessing = false;

	const processJobQueue = async () => {
		if (isProcessing) return;

		isProcessing = true;

		while (queue.length > 0) {
			const job = queue.at(0);
			try {
				await job;
			} catch (error) {
				console.error('Job failed:', error);
			} finally {
				queue.shift();
			}
		}

		isProcessing = false;
	};

	return {
		queue,
		addJobToQueue: (job: () => T) => {
			queue.push(job());
			processJobQueue();
		},
	};
};
