// serial-bridge.js — Web Serial API wrapper with NMEA buffering
// v5 — Fixed buffer overflow, backpressure, and robust error handling

class SerialBridge {
    constructor() {
        this.port = null;
        this.reader = null;
        this.writer = null;
        this.isOpen = false;
        this.lineBuffer = '';
        this.readInProgress = false; // защита от параллельных чтений
		this._reading = false;
		this._closing = false;

        // Callbacks
        this.onMessage = null;    // (rawLine: string) => void
        this.onError = null;      // (error: Error) => void
        this.onClose = null;      // () => void
    }

    /**
     * Request port from user and open it
     * @param {number} baudRate - defaults to 9600
     */
    async open(baudRate = 9600) {
		
		console.log('[SerialBridge] open() started, baudRate =', baudRate);
		
        if (this.isOpen) {
			console.warn('[SerialBridge] Attempted to open already open port');
			return false;
        }

        try {
			
			console.log('[SerialBridge] Requesting port...');
			
            this.port = await navigator.serial.requestPort();
			
			console.log('[SerialBridge] Port selected:', this.port);
			console.log('[SerialBridge] Opening port with baud rate', baudRate);
			
            await this.port.open({
                baudRate: baudRate,
                dataBits: 8,
                stopBits: 1,
                parity: 'none',
                flowControl: 'none',
                bufferSize: 65536
            });
			
			console.log('[SerialBridge] Port opened successfully');
			
			await this._drainStaleData();
			console.log('[SerialBridge] Stale data drained');

            this.isOpen = true;
            this.lineBuffer = '';
            this.readInProgress = false;
            this.writer = this.port.writable.getWriter();
            this.reader = this.port.readable.getReader();
			console.log('[SerialBridge] Reader and writer initialized');
			
            this._readLoop();
			console.log('[SerialBridge] _readLoop() launched');
            return true;
			
        } catch (err) {
			if (err.name === 'SecurityError') {
				const securityErr = new Error('Permission request requires user gesture (click/tap)');
				console.error('[SerialBridge] SecurityError:', securityErr.message);
				if (this.onError) this.onError(securityErr);
				throw securityErr;
			}
			console.error('[SerialBridge] Failed to open port:', err);
			if (this.onError) this.onError(err);
			throw err;
        }
    }
	
	/**
	 * Сбрасывает старые данные из буфера сразу после открытия порта
	 */
	async _drainStaleData() {
		if (!this.port || !this.port.readable) {
			return;
		}

		const reader = this.port.readable.getReader();

		try {
			let keepReading = 10;
			while (keepReading > 0) {
				try {
					const { done } = await reader.read();
					if (done) {
						keepReading = 0;
					} else {
						keepReading = keepReading - 1;
					}
				} catch (err) {
					// Игнорируем типичные ошибки при сбросе: NetworkError, AbortError и т. п.
					// Они возникают, когда порт закрывается или прерывается чтение
					keepReading = false;
				}
			}
		} catch (outerErr) {
			// Крайне редкий случай — логгируем для диагностики, но не прерываем работу
			console.warn('[SerialBridge] Unexpected error in _drainStaleData:', outerErr);
		} finally {
			try {
				reader.releaseLock();
			} catch (e) {
				// Игнорируем ошибки при освобождении блокировки
			}
		}
	}

    /**
     * Send raw string to port
     */
    async send(message) {
		if (!this.isOpen || !this.writer) {
			throw new Error('Port not open or writer unavailable');
		}
		
        const data = new TextEncoder().encode(message);
		try {
			await this.writer.write(data);
		} catch (err) {
			console.error('[SerialBridge] Send error:', err);
		}		
    }

    /**
     * Internal read loop — try/catch inside while
     */
	async _readLoop() {
		// Защита от повторного запуска цикла
		if (this._reading) {
			console.warn('[SerialBridge] _readLoop() called while already reading');
			return;
		}
		this._reading = true;

		const decoder = new TextDecoder();
		console.log('[SerialBridge] Read loop started');

		// Быстрая проверка на старте: если уже закрыт — выходим сразу
		if (!this.isOpen || !this.reader || !this.port) {
			console.log('[SerialBridge] Read loop skipped: not open or no reader/port');
			this._reading = false;
			return;
		}

		while (this.reader && this.isOpen && !this.readInProgress) {
			try {
				this.readInProgress = true;
				// Таймаут для предотвращения «вечного ожидания» на чтении
				const readPromise = this.reader.read();
				const timeoutPromise = new Promise((_, reject) =>
					setTimeout(() => reject(new Error('Read timeout')), 30000)
				);
				const { value, done } = await Promise.race([readPromise, timeoutPromise]);
				this.readInProgress = false;

				if (done) break;
				if (!value || value.length === 0) continue;

				const chunk = decoder.decode(value, {stram: true});
				this.lineBuffer += chunk;

				let idx;
				while ((idx = this.lineBuffer.indexOf('\n')) >= 0) {
					let line = this.lineBuffer.substring(0, idx);
					this.lineBuffer = this.lineBuffer.substring(idx + 1);
					line = line.replace(/\r$/, '').trim();

					if (line && line.startsWith('$') && this.onMessage) {
						try {
							this.onMessage(line);
						} catch (e) {
							console.warn('[SerialBridge] onMessage error:', e.message);
						}
					}
				}

				// Защита от переполнения буфера
				if (this.lineBuffer.length > 16384) {
					console.warn('[SerialBridge] Buffer overflow, reset');
					this.lineBuffer = '';
				}
			} catch (err) {
				this.readInProgress = false;
				if (err.message === 'Read timeout') {
					console.warn('[SerialBridge] Read timeout, closing port');
					await this.close();
					break;
				}
				if (err.name === 'NetworkError' || err.name === 'AbortError') {
					console.log('[SerialBridge] Port disconnected (' + err.name + ')');
					break;
				}
				if (err.name === 'TypeError' && err.message.includes('closed')) {
					break;
				}
				console.warn('[SerialBridge] Read error:', err.name);
				// Небольшая пауза перед повторной попыткой, чтобы не перегружать цикл
				await new Promise(r => setTimeout(r, 100));
			}
		}

		console.log('[SerialBridge] Read loop ended');
		this._reading = false;
		this.isOpen = false;
		if (this.onClose) {
			try {
				this.onClose();
			} catch (e) {}
		}
	}

    /**
     * Close the port and release all resources
     */
	async close() {
		// Добавляем флаг, чтобы не обрабатывать повторный вызов
		if (this._closing) {
			console.log('[SerialBridge] Close already in progress, skipping');
			return;
		}
		this._closing = true;

		console.log('[SerialBridge] Closing...');

		if (!this.isOpen || !this.port) {
			console.log('[SerialBridge] Already closed or no port, skipping');
			this.isOpen = false;
			this._closing = false;
			return;
		}

		try {
			if (this.reader) {
				try { await this.reader.cancel(); } catch (err) { console.warn('Reader cancel error:', err.message); }
				try { this.reader.releaseLock(); } catch (e) {}
				this.reader = null;
			}
			if (this.writer) {
				try { this.writer.releaseLock(); } catch (e) {}
				this.writer = null;
			}
			if (this.port) {
				const closePromise = this.port.close();
				const timeoutPromise = new Promise((_, reject) =>
					setTimeout(() => reject(new Error('Port close timeout')), 5000)
				);
				try {
					await Promise.race([closePromise, timeoutPromise]);
				} catch (err) {
					if (err.message !== 'Port close timeout') {
						console.warn('Port close error:', err.message);
					}
				}
				this.port = null;
			}
		} catch (e) {
			console.warn('[SerialBridge] Close error:', e.message);
		} finally {
			this.isOpen = false;
			this.lineBuffer = '';
			this.readInProgress = false;
			this._closing = false; // Сбрасываем флаг
			console.log('[SerialBridge] Closed');
		}
	}



    get connected() {
        return this.isOpen && this.port !== null;
    }
}
