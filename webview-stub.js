// webview-stub.js — Заглушка Web Serial API для AzimuthWebSuite (WebView)
(function() {
    // Если нативный Web Serial API доступен — не подменяем
    if (navigator.serial && navigator.serial.requestPort) {
        console.log('[Stub] Native Web Serial API detected, skipping');
        return;
    }

    function createPort(portId) {
        return {
            _readable: null,
            _writable: null,
            
            get readable() {
                if (!this._readable) {
                    this._readable = new ReadableStream({
                        start: function(controller) {
                            window['_stubController' + portId] = controller;
                        }
                    });
                }
                return this._readable;
            },
            
            get writable() {
                if (!this._writable) {
                    this._writable = new WritableStream({
                        write: function(chunk) {
                            var text = typeof chunk === 'string' ? chunk : new TextDecoder().decode(chunk);
                            var iframe = document.createElement('iframe');
                            iframe.style.display = 'none';
                            iframe.src = 'uart://write?' + encodeURIComponent(portId + '|' + text);
                            document.body.appendChild(iframe);
                            setTimeout(function() { document.body.removeChild(iframe); }, 100);
                        }
                    });
                }
                return this._writable;
            },
            
            open: function(options) {
                this._readable = null;
                this._writable = null;
                return Promise.resolve();
            },
            
            close: function() { return Promise.resolve(); },
            getInfo: function() { return { usbVendorId: 0x0403, usbProductId: 0x6001 }; },
            forget: function() { return Promise.resolve(); },
            setSignals: function(s) { return Promise.resolve(); },
            getSignals: function() { return Promise.resolve({}); }
        };
    }

    var _portAzm = createPort(0);
    var _portGnss = createPort(1);
    var _currentPort = _portAzm; // Первый вызов — AZM
    
    navigator.serial = {
        requestPort: function(filters) {
            var port = _currentPort;
            _currentPort = _portGnss; // Следующий вызов — GNSS
            return Promise.resolve(port);
        },
        getPorts: function() { return Promise.resolve([_portAzm, _portGnss]); },
        addEventListener: function(event, callback) {},
        removeEventListener: function(event, callback) {}
    };

    // navigator.serial2 для прямого доступа к GNSS
    navigator.serial2 = {
        requestPort: function() { return Promise.resolve(_portGnss); },
        getPorts: function() { return Promise.resolve([_portGnss]); },
        addEventListener: function(event, callback) {},
        removeEventListener: function(event, callback) {}
    };

    console.log('[Stub] Web Serial API stub initialized for AzimuthWebSuite');
})();