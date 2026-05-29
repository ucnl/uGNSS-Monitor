// webview-stub.js — Universal Web Serial API stub for Android WebView
(function() {
    if (navigator.serial && navigator.serial.requestPort) {
        console.log('[Stub] Native Web Serial API detected, skipping');
        return;
    }

    const MAX_PORTS = 4;
    let portCounter = 0;
    let initialized = false;

    function createPort(portId) {
        return {
            _portId: portId,
            _readable: null,
            _writable: null,
            _baudRate: 9600,
            
            get readable() {
                if (!this._readable) {
                    this._readable = new ReadableStream({
                        start: (controller) => {
                            window['_stubController' + portId] = controller;
                            console.log('[Stub] ReadableStream created for port ' + portId);
                        }
                    });
                }
                return this._readable;
            },
            
            get writable() {
                if (!this._writable) {
                    this._writable = new WritableStream({
                        write: (chunk) => {
                            const text = typeof chunk === 'string' ? chunk : new TextDecoder().decode(chunk);
                            sendToNative('uart://write?' + encodeURIComponent(portId + '|' + text));
                        }
                    });
                }
                return this._writable;
            },
            
            open: function(options) {
                const baudRate = options?.baudRate || 9600;
                console.log('[Stub] Port ' + portId + ' open() baudRate=' + baudRate);
                
                if (baudRate !== this._baudRate) {
                    this._baudRate = baudRate;
                    sendToNative('uart://setbaud?' + encodeURIComponent(portId + '|' + baudRate));
                }
                
                this._readable = null;
                this._writable = null;
                
                return new Promise(resolve => setTimeout(resolve, 300));
            },
            
            close: function() {
                console.log('[Stub] Port ' + portId + ' close()');
                this._baudRate = 9600;
                sendToNative('uart://close?' + portId);
                return Promise.resolve();
            },
            
            getInfo: function() {
                return { usbVendorId: 0x0403, usbProductId: 0x6001 };
            },
            
            forget: function() { return Promise.resolve(); },
            setSignals: function(s) { return Promise.resolve(); },
            getSignals: function() { return Promise.resolve({}); }
        };
    }

    function sendToNative(url) {
        const iframe = document.createElement('iframe');
        iframe.style.display = 'none';
        iframe.src = url;
        document.body.appendChild(iframe);
        setTimeout(() => document.body.removeChild(iframe), 100);
    }

    const ports = [];
    for (let i = 0; i < MAX_PORTS; i++) {
        ports.push(createPort(i));
    }

    window._initStub = function(config) {
        if (initialized) return;
        initialized = true;
        
        const appName = config?.appName || 'unknown';
        const preferredPort = config?.preferredPort || 0;
        
        portCounter = preferredPort;
        
        console.log('[Stub] Initialized for ' + appName + ' (starting port: ' + preferredPort + ', total: ' + MAX_PORTS + ')');
    };

    navigator.serial = {
        requestPort: function(filters) {
            const portIndex = portCounter % MAX_PORTS;
            portCounter++;
            console.log('[Stub] requestPort() -> port ' + portIndex);
            return Promise.resolve(ports[portIndex]);
        },
        getPorts: function() {
            return Promise.resolve([...ports]);
        },
        addEventListener: function() {},
        removeEventListener: function() {}
    };

    // ========== Перехват скачивания файлов для Android ==========
	// Перехватываем HTMLAnchorElement.prototype.click
	(function() {
		var originalClick = HTMLAnchorElement.prototype.click;
		var blobUrls = new Map();
		var originalCreateObjectURL = URL.createObjectURL;
		
		URL.createObjectURL = function(blob) {
			var url = originalCreateObjectURL.call(URL, blob);
			blobUrls.set(url, blob);
			return url;
		};
		
		HTMLAnchorElement.prototype.click = function() {
			if (this.download && this.href && this.href.startsWith('blob:')) {
				console.log('[Stub] Intercepted click(): ' + this.download);
				
				var filename = this.download;
				var blob = blobUrls.get(this.href);
				
				if (blob) {
					var reader = new FileReader();
					reader.onload = function() {
						var base64 = reader.result.split(',')[1];
						var iframe = document.createElement('iframe');
						iframe.style.display = 'none';
						iframe.src = 'app://savefile?' + encodeURIComponent(filename + '|' + base64);
						document.body.appendChild(iframe);
						setTimeout(function() { document.body.removeChild(iframe); }, 100);
					};
					reader.readAsDataURL(blob);
				}
				return;
			}
			return originalClick.call(this);
		};
		
		console.log('[Stub] HTMLAnchorElement.click() interceptor registered');
	})();
    // =============================================================

    console.log('[Stub] Universal Web Serial stub loaded (' + MAX_PORTS + ' ports)');
})();