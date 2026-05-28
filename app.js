// app.js — uGNSS Monitor PWA
// Подключает GNSS-компас, отображает трек, считает DRMS и RMS

const App = (() => {

    // ========== DOM-ЭЛЕМЕНТЫ ==========
    let canvas, ctx;
    let mapContainer;
    let connectionIndicator, statusText, deviceLabel;
    let btnConnection, btnSettings;
    let activeDropdown = null;

    // ========== СОСТОЯНИЕ ==========
    let serialBridge = null;
    let isConnected = false;
	let gnssData = {
		lat: NaN, lon: NaN,
		heading: NaN, speed: NaN, course: NaN,
		numSV: 0, hdop: NaN, fixType: 0,
	};
    let track = [];           // [{ x, y, lat, lon, ts }]
    let anchorLat = NaN, anchorLon = NaN;
    const MAX_TRACK = 10000;
	
	// Счётчики сообщений и тайминги для частоты
	let rmcTimestamps = [];
	let hdtTimestamps = [];
	let gsaTimestamps = [];
	let rateCalcInterval = null;

    // Статистика
    let statsWindow = 60;
    let headingHistory = [];
    let jumpsCount = 0;
    let lastHeading = NaN;
	
	// Bounding box облака точек
	let bbox = {
		latMin: Infinity, latMax: -Infinity,
		lonMin: Infinity, lonMax: -Infinity,
	};

    // Карта
    let scale = 100;
    let offsetX = 0, offsetY = 0;
    let isDragging = false;
    let lastMouseX = 0, lastMouseY = 0;
    let autoScaleEnabled = true;
	let followMode = false;   // режим следования за позицией
	let btnCenter = null;

    // Темы
    const themes = ['theme-indoor', 'theme-light', 'theme-dark-contrast'];
    let currentTheme = 0;

    // ========== ВСПОМОГАТЕЛЬНЫЕ ==========
    function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
    
    function setStatus(msg) {
        if (statusText) statusText.textContent = msg;
        console.log('[App]', msg);
    }

    function toggleDropdown(id) {
        const menu = document.getElementById(id);
        if (activeDropdown && activeDropdown !== menu) activeDropdown.style.display = 'none';
        if (menu.style.display === 'block') { menu.style.display = 'none'; activeDropdown = null; }
        else { menu.style.display = 'block'; activeDropdown = menu; }
    }

    function closeAllDropdowns() {
        if (activeDropdown) { activeDropdown.style.display = 'none'; activeDropdown = null; }
    }

    function cycleTheme() {
        document.documentElement.classList.remove(...themes);
        currentTheme = (currentTheme + 1) % themes.length;
        if (currentTheme > 0) document.documentElement.classList.add(themes[currentTheme]);
        localStorage.setItem('theme', currentTheme);
    }

    // ========== ИНИЦИАЛИЗАЦИЯ ==========
	function init() {
		canvas = document.getElementById('map-canvas');
		ctx = canvas.getContext('2d');
		mapContainer = document.getElementById('map-container');
		connectionIndicator = document.getElementById('connection-indicator');
		statusText = document.getElementById('status-text');
		deviceLabel = document.getElementById('device-label');
		btnConnection = document.getElementById('btn-connection');
		btnSettings = document.getElementById('btn-settings');
		btnCenter = document.getElementById('btn-center');  // только ОДИН раз

		if (btnCenter) {
			btnCenter.classList.remove('active');
			btnCenter.textContent = '⊙';
		}

		document.addEventListener('click', (e) => {
			if (!e.target.closest('.dropdown')) closeAllDropdowns();
		});

		const savedTheme = parseInt(localStorage.getItem('theme') || '0');
		currentTheme = savedTheme;
		if (currentTheme > 0) document.documentElement.classList.add(themes[currentTheme]);

		resizeCanvas();
		window.addEventListener('resize', resizeCanvas);
		initMouseHandlers();
		initTouchHandlers();
		loadSettings();
		rateCalcInterval = setInterval(calcMessageRate, 1000);

		requestAnimationFrame(renderLoop);
	}
	
    // ========== ПОДКЛЮЧЕНИЕ ==========
	async function connectSerial() {
		if (serialBridge) {
			try { await serialBridge.close(); } catch (e) {}
			serialBridge = null;
		}

		try {
			setStatus('Подключение...');
			btnConnection.disabled = true;

			serialBridge = new SerialBridge();
			serialBridge.onMessage = onSerialMessage;
			serialBridge.onError = onSerialError;
			serialBridge.onClose = onSerialClose;

			const saved = localStorage.getItem('ugnss_settings');
			const baudRate = saved ? (JSON.parse(saved).baudRate || 38400) : 38400;
			await serialBridge.open(baudRate);

			isConnected = true;
			connectionIndicator.className = 'connected';
			btnConnection.textContent = '⏏ Отключить';
			btnConnection.className = 'top-btn btn-disconnect';
			btnConnection.disabled = false;  // ← ВОТ ЭТО ДОБАВИТЬ
			setStatus('Подключено (' + baudRate + ')');
		} catch (err) {
			btnConnection.disabled = false;  // ← И ЗДЕСЬ ТОЖЕ
			if (err.name === 'NotFoundError') {
				setStatus('Подключение отменено');
			} else {
				setStatus('Ошибка: ' + err.message);
			}
		}	
    }

    async function disconnectSerial() {
        if (serialBridge) {
            try { await serialBridge.close(); } catch (e) {}
            serialBridge = null;
        }
        onSerialClose();
    }

    function toggleConnection() {
        if (isConnected) disconnectSerial();
        else connectSerial();
    }

	function toggleCenter() {
		followMode = !followMode;
		if (!btnCenter) return;
		
		if (followMode) {
			btnCenter.classList.add('active');
			btnCenter.textContent = '◉';
			// Сразу центрируем
			offsetX = canvas.width / 2;
			offsetY = canvas.height / 2;
			setStatus('Слежение: ВКЛ (начало координат в центре)');
		} else {
			btnCenter.classList.remove('active');
			btnCenter.textContent = '⊙';
			setStatus('Слежение: ВЫКЛ');
		}
	}

    // ========== ОБРАБОТЧИКИ ==========
	function onSerialMessage(rawLine) {
		const line = rawLine.trim();
		const data = GNSSParser.parse(line);
		if (!data) return;

		if (data.type === 'rmc' && !isNaN(data.latitude) && !isNaN(data.longitude)) {
			rmcTimestamps.push(Date.now());
			if (rmcTimestamps.length > 100) rmcTimestamps.shift();
			
			gnssData.lat = data.latitude;
			gnssData.lon = data.longitude;
			if (!isNaN(data.speedMps)) gnssData.speed = data.speedMps;
			if (!isNaN(data.course)) gnssData.course = data.course;
			if (!isNaN(data.numSV)) gnssData.numSV = data.numSV;
			if (!isNaN(data.hdop)) gnssData.hdop = data.hdop;
			if (data.quality) gnssData.fixType = data.quality;
			addTrackPoint(data.latitude, data.longitude);			
		} else if (data.type === 'gga' && !isNaN(data.latitude) && !isNaN(data.longitude)) {
			// GGA даёт спутники, HDOP, fix type
			if (!isNaN(data.hdop)) gnssData.hdop = data.hdop;
			if (data.numSV > 0) gnssData.numSV = data.numSV;
			if (data.quality) gnssData.fixType = data.quality;
		} else if ((data.type === 'hdt' || data.type === 'hdm') && !isNaN(data.heading)) {
			hdtTimestamps.push(Date.now());
			if (hdtTimestamps.length > 100) hdtTimestamps.shift();			
			gnssData.heading = data.heading;
			updateHeadingStats(data.heading);
		} else if (data.type === 'gsa') {
			gsaTimestamps.push(Date.now());
			if (gsaTimestamps.length > 100) gsaTimestamps.shift();			
			if (!isNaN(data.hdop)) gnssData.hdop = data.hdop;
			if (data.fixType) gnssData.fixType = data.fixType;
		}
	}

    function onSerialError(error) {
        if (error.name === 'NotFoundError') return;
        if (error.name === 'BufferOverrunError') return;
        console.error('[GNSS] Ошибка:', error.message);
    }

	function onSerialClose() {
		isConnected = false;
		serialBridge = null;
		connectionIndicator.className = '';
		btnConnection.textContent = '📡 Подключить';
		btnConnection.className = 'top-btn btn-connect';
		btnConnection.disabled = false;
		
		// Очищаем таймстемпы
		rmcTimestamps = [];
		hdtTimestamps = [];
		gsaTimestamps = [];
		
		// Очищаем отображение
		const rmcEl = document.getElementById('st-rate-rmc');
		const hdtEl = document.getElementById('st-rate-hdt');
		const gsaEl = document.getElementById('st-rate-gsa');
		if (rmcEl) { rmcEl.textContent = '--'; rmcEl.style.color = 'var(--text-muted)'; }
		if (hdtEl) { hdtEl.textContent = '--'; hdtEl.style.color = 'var(--text-muted)'; }		
		if (gsaEl) { gsaEl.textContent = '--'; gsaEl.style.color = 'var(--text-muted)'; }
		
		setStatus('Не подключено');
	}

    // ========== ТРЕК ==========
    function addTrackPoint(lat, lon) {
        if (isNaN(lat) || isNaN(lon)) return;
		
		// Обновляем bounding box
		if (lat < bbox.latMin) bbox.latMin = lat;
		if (lat > bbox.latMax) bbox.latMax = lat;
		if (lon < bbox.lonMin) bbox.lonMin = lon;
		if (lon > bbox.lonMax) bbox.lonMax = lon;		
		
        if (track.length === 0) {
            anchorLat = lat;
            anchorLon = lon;
            track.push({ x: 0, y: 0, lat, lon, ts: Date.now() });
            return;
        }

        const m = geoToMeters(lat, lon);
        if (track.length > 0) {
            const last = track[track.length - 1];
            if (Math.abs(m.x - last.x) < 0.001 && Math.abs(m.y - last.y) < 0.001) return;
        }

        track.push({ x: m.x, y: m.y, lat, lon, ts: Date.now() });
        if (track.length > MAX_TRACK) {
			const half = Math.floor(MAX_TRACK / 2);
			track.splice(0, track.length - half);  // оставляем последние half точек
			recalcBBox();
		}
    }
	
	function recalcBBox() {
		bbox.latMin = Infinity; bbox.latMax = -Infinity;
		bbox.lonMin = Infinity; bbox.lonMax = -Infinity;
		
		for (const p of track) {
			if (p.lat < bbox.latMin) bbox.latMin = p.lat;
			if (p.lat > bbox.latMax) bbox.latMax = p.lat;
			if (p.lon < bbox.lonMin) bbox.lonMin = p.lon;
			if (p.lon > bbox.lonMax) bbox.lonMax = p.lon;
		}
	}

    function geoToMeters(lat, lon) {
        if (isNaN(anchorLat) || isNaN(anchorLon)) return { x: 0, y: 0 };
        const mlat = (lat + anchorLat) / 2 * Math.PI / 180;
        const mPerDegLat = 111132.92 - 559.82 * Math.cos(2 * mlat) + 1.175 * Math.cos(4 * mlat);
        const mPerDegLon = 111412.84 * Math.cos(mlat) - 93.5 * Math.cos(3 * mlat);
        return {
            x: (lon - anchorLon) * mPerDegLon,
            y: (lat - anchorLat) * mPerDegLat,
        };
    }

    function getAntennaXY() {
        if (isNaN(gnssData.lat) || isNaN(gnssData.lon) || isNaN(anchorLat)) return { x: 0, y: 0 };
        return geoToMeters(gnssData.lat, gnssData.lon);
    }

    // ========== СТАТИСТИКА ==========
    function updateHeadingStats(heading) {
        if (!isNaN(lastHeading)) {
            let diff = Math.abs(heading - lastHeading);
            if (diff > 180) diff = 360 - diff;
            if (diff / 1.0 > 30) jumpsCount++; // ~1 сек между HDG
        }
        lastHeading = heading;
        headingHistory.push(heading);
        if (headingHistory.length > statsWindow * 2) headingHistory.shift();
    }

    function calcStats() {
        // DRMS по треку
        const windowPoints = track.slice(-statsWindow).filter(p => !isNaN(p.x));
        if (windowPoints.length >= 5) {
            let cx = 0, cy = 0;
            windowPoints.forEach(p => { cx += p.x; cy += p.y; });
            cx /= windowPoints.length; cy /= windowPoints.length;

            let sx = 0, sy = 0;
            windowPoints.forEach(p => {
                sx += (p.x - cx) ** 2;
                sy += (p.y - cy) ** 2;
            });
            const stdX = Math.sqrt(sx / windowPoints.length);
            const stdY = Math.sqrt(sy / windowPoints.length);
            const drms = Math.sqrt(stdX * stdX + stdY * stdY);

            document.getElementById('st-drms').textContent = drms.toFixed(2);
            document.getElementById('st-2drms').textContent = (drms * 2).toFixed(2);
            document.getElementById('st-3drms').textContent = (drms * 3).toFixed(2);
            document.getElementById('st-points').textContent = windowPoints.length;
        }

        // RMS азимута
        const hdgWindow = headingHistory.slice(-statsWindow);
        if (hdgWindow.length >= 5) {
            let sum = 0;
            for (let i = 1; i < hdgWindow.length; i++) {
                let diff = Math.abs(hdgWindow[i] - hdgWindow[i-1]);
                if (diff > 180) diff = 360 - diff;
                sum += diff * diff;
            }
            const rms = Math.sqrt(sum / (hdgWindow.length - 1));
            document.getElementById('st-hdg-rms').textContent = rms.toFixed(3);
        } else {
			document.getElementById('st-hdg-rms').textContent = '--';			
		}

        document.getElementById('st-jumps').textContent = jumpsCount;
		
		// Размер облака (размах по NS и EW в метрах)
		if (track.length >= 2 && bbox.latMin !== Infinity) {
			// Конвертируем разницу lat/lon в метры (приближённо, по среднему)
			const midLat = (bbox.latMin + bbox.latMax) / 2 * Math.PI / 180;
			const mPerDegLat = 111132.92 - 559.82 * Math.cos(2 * midLat) + 1.175 * Math.cos(4 * midLat);
			const mPerDegLon = 111412.84 * Math.cos(midLat) - 93.5 * Math.cos(3 * midLat);
			
			const extentNS = (bbox.latMax - bbox.latMin) * mPerDegLat;
			const extentEW = (bbox.lonMax - bbox.lonMin) * mPerDegLon;
			const extentDiag = Math.sqrt(extentNS * extentNS + extentEW * extentEW);
			
			// Форматируем в зависимости от размера
			const fmt = (v) => {
				if (v < 1) return (v * 100).toFixed(1) + ' см';
				if (v < 1000) return v.toFixed(2);
				return (v / 1000).toFixed(3) + ' км';
			};
			
			const elNS = document.getElementById('st-extent-ns');
			const elEW = document.getElementById('st-extent-ew');
			const elExt = document.getElementById('st-extent');
			
			if (elNS) elNS.textContent = fmt(extentNS);
			if (elEW) elEW.textContent = fmt(extentEW);
			if (elExt) elExt.textContent = fmt(extentDiag);
		}
    }

    function resetStats() {
        statsWindow = parseInt(document.getElementById('cfg-window').value) || 60;
        headingHistory = [];
        jumpsCount = 0;
        lastHeading = NaN;
		
		// Сбрасываем bbox (начнёт заполняться заново)
		bbox.latMin = Infinity; bbox.latMax = -Infinity;
		bbox.lonMin = Infinity; bbox.lonMax = -Infinity;
    }

	function calcMessageRate() {
		const now = Date.now();
		const oneSecondAgo = now - 1000;
		
		const rmcRate = rmcTimestamps.filter(ts => ts > oneSecondAgo).length;
		const hdtRate = hdtTimestamps.filter(ts => ts > oneSecondAgo).length;
		const gsaRate = gsaTimestamps.filter(ts => ts > oneSecondAgo).length;
		
		// RMC
		const rmcEl = document.getElementById('st-rate-rmc');
		if (rmcEl) {
			rmcEl.textContent = rmcRate || '--';
			rmcEl.style.color = rmcRate >= 5 ? 'var(--text-accent)' : 
							   rmcRate >= 1 ? 'var(--text-warning)' : 
							   rmcRate > 0 ? '#ff6666' : 'var(--text-muted)';
		}
		
		// HDT
		const hdtEl = document.getElementById('st-rate-hdt');
		if (hdtEl) {
			hdtEl.textContent = hdtRate || '--';
			hdtEl.style.color = hdtRate >= 10 ? 'var(--text-accent)' : 
							   hdtRate >= 5 ? 'var(--text-warning)' : 
							   hdtRate > 0 ? '#ff6666' : 'var(--text-muted)';
		}
		
		// GSA — отдельно, чтобы видеть не суммируется ли с RMC
		const gsaEl = document.getElementById('st-rate-gsa');
		if (gsaEl) {
			gsaEl.textContent = gsaRate || '--';
			gsaEl.style.color = gsaRate > 0 ? 'var(--text-info)' : 'var(--text-muted)';
		}
	}

    // ========== НАСТРОЙКИ ==========
    function openSettings() {
        document.getElementById('settings-overlay').classList.add('visible');
    }

    function closeSettings() {
        document.getElementById('settings-overlay').classList.remove('visible');
    }

    function applySettings() {
        saveSettings();
        closeSettings();
        setStatus('Настройки применены');
    }

    function saveSettings() {
        const data = {
            baudRate: parseInt(document.getElementById('cfg-gnss-baud')?.value) || 38400,
        };
        try { localStorage.setItem('ugnss_settings', JSON.stringify(data)); } catch (e) {}
    }

    function loadSettings() {
        try {
            const saved = localStorage.getItem('ugnss_settings');
            if (saved) {
                const data = JSON.parse(saved);
                if (data.baudRate && document.getElementById('cfg-gnss-baud')) {
                    document.getElementById('cfg-gnss-baud').value = data.baudRate;
                }
            }
        } catch (e) {}
    }

    // ========== ЭКСПОРТ ==========
    function exportCSV() {
        if (track.length === 0) { alert('Нет данных трека'); return; }
        const lines = ['time,latitude,longitude,heading_deg,speed_mps,course_deg'];
        for (const p of track) {
            const ts = new Date(p.ts).toISOString();
            lines.push(`${ts},${p.lat.toFixed(8)},${p.lon.toFixed(8)},${gnssData.heading.toFixed(2)},${gnssData.speed.toFixed(3)},${gnssData.course.toFixed(1)}`);
        }
        downloadBlob(lines.join('\n'), 'text/csv', `ugnss_track_${new Date().toISOString().slice(0,19).replace(/[:.]/g,'-')}.csv`);
    }

    function exportCSVStats() {
        const lines = ['stat,value'];
        lines.push(`DRMS_m,${document.getElementById('st-drms').textContent}`);
        lines.push(`2DRMS_m,${document.getElementById('st-2drms').textContent}`);
        lines.push(`3DRMS_m,${document.getElementById('st-3drms').textContent}`);
        lines.push(`Heading_RMS_deg,${document.getElementById('st-hdg-rms').textContent}`);
        lines.push(`Jumps_gt_30dps,${jumpsCount}`);
        lines.push(`Window_points,${statsWindow}`);
        lines.push(`Total_points,${track.length}`);
        downloadBlob(lines.join('\n'), 'text/csv', `ugnss_stats_${new Date().toISOString().slice(0,19).replace(/[:.]/g,'-')}.csv`);
    }

	function exportKML() {
		if (track.length < 2) { alert('Нет данных трека'); return; }
		let kml = `<?xml version="1.0" encoding="UTF-8"?>
	<kml xmlns="http://www.opengis.net/kml/2.2">
	  <Document>
		<name>uGNSS Track</name>
		<Style id="track_style">
		  <LineStyle><color>ff00ffff</color><width>3</width></LineStyle>
		</Style>
		<Placemark>
		  <name>GNSS трек</name>
		  <styleUrl>#track_style</styleUrl>
		  <LineString><tessellate>1</tessellate><coordinates>
	`;
		for (const p of track) {
			if (!isNaN(p.lat) && !isNaN(p.lon)) {
				kml += `        ${p.lon.toFixed(6)},${p.lat.toFixed(6)},0\n`;
			}
		}
		kml += `      </coordinates></LineString>
		</Placemark>
	  </Document>
	</kml>`;
		downloadBlob(kml, 'application/vnd.google-earth.kml+xml', `ugnss_track_${new Date().toISOString().slice(0,19).replace(/[:.]/g,'-')}.kml`);
	}


    function downloadBlob(content, type, filename) {
        const blob = new Blob([content], { type });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url; a.download = filename;
        document.body.appendChild(a); a.click();
        document.body.removeChild(a); URL.revokeObjectURL(url);
    }

    // ========== ОТРИСОВКА ==========
    function resizeCanvas() {
        const w = mapContainer.clientWidth;
        const h = mapContainer.clientHeight;
        if (canvas.width !== w || canvas.height !== h) {
            canvas.width = w;
            canvas.height = h;
            if (offsetX === 0 && offsetY === 0) { offsetX = w / 2; offsetY = h / 2; }
        }
    }

	function renderLoop() {
		if (followMode && !isDragging) {
			// Текущая позиция антенны всегда в центре экрана (на перекрестье осей)
			const ant = getAntennaXY();
			offsetX = canvas.width / 2 - ant.x * scale;
			offsetY = canvas.height / 2 + ant.y * scale;
		}
		drawAll();
		calcStats();
		requestAnimationFrame(renderLoop);
	}

    function drawAll() {
        if (!ctx || canvas.width === 0) return;
        ctx.clearRect(0, 0, canvas.width, canvas.height);
        drawGrid();
        drawTrack();
        drawPosition();
        drawScaleBar();
        updateInfoUI();
    }

    function drawGrid() {
        const gridSize = 50;
        const isLight = document.documentElement.classList.contains('theme-light');
        const isDark = document.documentElement.classList.contains('theme-dark-contrast');
        const gridColor = isLight ? 'rgba(0,0,0,0.06)' : isDark ? 'rgba(255,255,255,0.1)' : 'rgba(255,255,255,0.05)';
        const axisColor = isLight ? 'rgba(0,0,0,0.15)' : isDark ? 'rgba(255,255,255,0.3)' : 'rgba(255,255,255,0.15)';

        ctx.strokeStyle = gridColor;
        ctx.lineWidth = 1;
        const startX = ((offsetX % gridSize) + gridSize) % gridSize;
        for (let x = startX; x < canvas.width; x += gridSize) {
            ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, canvas.height); ctx.stroke();
        }
        const startY = ((offsetY % gridSize) + gridSize) % gridSize;
        for (let y = startY; y < canvas.height; y += gridSize) {
            ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(canvas.width, y); ctx.stroke();
        }

        ctx.strokeStyle = axisColor;
        ctx.lineWidth = 2;
        ctx.beginPath(); ctx.moveTo(offsetX, 0); ctx.lineTo(offsetX, canvas.height); ctx.stroke();
        ctx.beginPath(); ctx.moveTo(0, offsetY); ctx.lineTo(canvas.width, offsetY); ctx.stroke();
    }

    function drawTrack() {
        if (track.length < 2) return;
        const drawCount = Math.min(track.length, 500);
        const startIdx = track.length - drawCount;

        ctx.beginPath();
        let first = true;
        for (let i = startIdx; i < track.length; i++) {
            const p = track[i];
            const x = offsetX + p.x * scale;
            const y = offsetY - p.y * scale;
            if (first) { ctx.moveTo(x, y); first = false; }
            else { ctx.lineTo(x, y); }
        }
        if (!first) {
            ctx.strokeStyle = 'rgba(0, 255, 255, 0.15)';
            ctx.lineWidth = 5;
            ctx.stroke();
            ctx.strokeStyle = 'rgba(0, 255, 255, 0.6)';
            ctx.lineWidth = 2;
            ctx.stroke();
        }
    }

	function drawPosition() {
		const ant = getAntennaXY();
		const x = offsetX + ant.x * scale;
		const y = offsetY - ant.y * scale;

		const triSize = 18;  // увеличенный треугольник

		// Тень для треугольника
		ctx.save();
		ctx.shadowColor = 'rgba(0,0,0,0.5)';
		ctx.shadowBlur = 8;

		// Основной треугольник
		ctx.beginPath();
		ctx.moveTo(x, y - triSize);
		ctx.lineTo(x + triSize * 0.75, y + triSize * 0.6);
		ctx.lineTo(x - triSize * 0.75, y + triSize * 0.6);
		ctx.closePath();

		// Градиентная заливка
		const grad = ctx.createLinearGradient(x, y - triSize, x, y + triSize * 0.6);
		grad.addColorStop(0, '#ffdd00');
		grad.addColorStop(1, '#ff8800');
		ctx.fillStyle = grad;
		ctx.fill();

		// Обводка
		ctx.strokeStyle = '#fff';
		ctx.lineWidth = 2.5;
		ctx.stroke();
		ctx.restore();

		// Текст "GPS" внутри треугольника
		ctx.fillStyle = '#000';
		ctx.font = 'bold 10px "Segoe UI", Arial, sans-serif';
		ctx.textAlign = 'center';
		ctx.textBaseline = 'middle';
		ctx.fillText('GPS', x, y - 1);

		// Стрелка курса (из центра треугольника наружу)
		if (!isNaN(gnssData.heading)) {
			const ang = (gnssData.heading - 90) * Math.PI / 180;
			const startRadius = triSize * 0.35;   // начинаем от центра
			const totalLen = 30;
			const headLen = 10;

			const sx = x + startRadius * Math.cos(ang);
			const sy = y + startRadius * Math.sin(ang);
			const ex = x + totalLen * Math.cos(ang);
			const ey = y + totalLen * Math.sin(ang);

			ctx.save();
			ctx.shadowColor = 'rgba(0,0,0,0.4)';
			ctx.shadowBlur = 4;

			// Древко
			ctx.beginPath();
			ctx.moveTo(sx, sy);
			ctx.lineTo(ex, ey);
			ctx.strokeStyle = '#ff3333';
			ctx.lineWidth = 3.5;
			ctx.stroke();

			// Наконечник
			ctx.beginPath();
			ctx.moveTo(ex, ey);
			ctx.lineTo(
				ex - headLen * Math.cos(ang - 0.6),
				ey - headLen * Math.sin(ang - 0.6)
			);
			ctx.lineTo(
				ex - headLen * Math.cos(ang + 0.6),
				ey - headLen * Math.sin(ang + 0.6)
			);
			ctx.closePath();
			ctx.fillStyle = '#ff3333';
			ctx.fill();

			ctx.restore();
		}
	}

    function drawScaleBar() {
        const rawM = 100 / scale;
        const nice = [1, 2, 5, 10, 25, 50, 100, 250, 500, 1000, 2500];
        let dm = nice.find(n => n >= rawM) || Math.round(rawM / 1000) * 1000;
        let dp = dm * scale;
        if (dp > canvas.width - 60) { dp = canvas.width - 60; dm = Math.round(dp / scale); }

        const bx = canvas.width - dp - 20;
        const by = canvas.height - 18;
        const isLight = document.documentElement.classList.contains('theme-light');
        const color = isLight ? '#1a1a1a' : '#fff';

        ctx.beginPath(); ctx.moveTo(bx, by); ctx.lineTo(bx + dp, by);
        ctx.strokeStyle = color; ctx.lineWidth = 2; ctx.stroke();
        ctx.font = 'bold 9px Arial'; ctx.fillStyle = color; ctx.textAlign = 'center';
        ctx.fillText(dm >= 1000 ? `${(dm/1000).toFixed(1)} км` : `${Math.round(dm)} м`, bx + dp / 2, by - 8);
    }

    function updateInfoUI() {
        document.getElementById('gi-lat').textContent = isNaN(gnssData.lat) ? '--' : gnssData.lat.toFixed(6);
        document.getElementById('gi-lon').textContent = isNaN(gnssData.lon) ? '--' : gnssData.lon.toFixed(6);
        document.getElementById('gi-hdg').textContent = isNaN(gnssData.heading) ? '--' : gnssData.heading.toFixed(1);
        document.getElementById('gi-spd').textContent = isNaN(gnssData.speed) ? '--' : gnssData.speed.toFixed(2);
        document.getElementById('gi-crs').textContent = isNaN(gnssData.course) ? '--' : gnssData.course.toFixed(1);
		document.getElementById('gi-sats').textContent = gnssData.numSV > 0 ? gnssData.numSV : '--';
		document.getElementById('gi-hdop').textContent = !isNaN(gnssData.hdop) ? gnssData.hdop.toFixed(1) : '--';
		const qualityNames = ['Нет', 'GPS', 'DGPS', 'PPS', 'RTK', 'FloatRTK', 'Est', 'Manual', 'Sim'];
		document.getElementById('gi-quality').textContent = gnssData.fixType > 0 ? (qualityNames[gnssData.fixType] || gnssData.fixType) : '--';
    }

    // ========== МЫШЬ И ТАЧ ==========
    function initMouseHandlers() {
        canvas.addEventListener('wheel', (e) => {
            e.preventDefault();
            const rect = canvas.getBoundingClientRect();
            const mx = e.clientX - rect.left;
            const my = e.clientY - rect.top;
            const wx = (mx - offsetX) / scale;
            const wy = (offsetY - my) / scale;
            scale *= e.deltaY > 0 ? 0.85 : 1.18;
            scale = Math.min(Math.max(scale, 0.1), 5000);
            offsetX = mx - wx * scale;
            offsetY = my + wy * scale;
            autoScaleEnabled = false;
        });

		canvas.addEventListener('mousedown', (e) => {
			e.preventDefault();
			isDragging = true;
			lastMouseX = e.clientX; lastMouseY = e.clientY;
			canvas.style.cursor = 'grabbing';
			// Если был режим слежения — временно выключаем
			if (followMode) {
				followMode = false;
				if (btnCenter) {
					btnCenter.classList.remove('active');
				}
				setStatus('Слежение приостановлено (двойной клик — возобновить)');
			}
		});

        canvas.addEventListener('mousemove', (e) => {
            if (!isDragging) return;
            offsetX += e.clientX - lastMouseX;
            offsetY += e.clientY - lastMouseY;
            lastMouseX = e.clientX; lastMouseY = e.clientY;
            autoScaleEnabled = false;
        });

        canvas.addEventListener('mouseup', () => { isDragging = false; canvas.style.cursor = 'grab'; });
        canvas.addEventListener('mouseleave', () => { isDragging = false; canvas.style.cursor = 'grab'; });

		canvas.addEventListener('dblclick', () => {
			// Если не в режиме слежения — включаем
			if (!followMode) {
				toggleCenter();
			}
			// Автомасштабирование по треку
			autoScaleEnabled = true;
			if (track.length > 1) {
				let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
				track.forEach(p => {
					minX = Math.min(minX, p.x); maxX = Math.max(maxX, p.x);
					minY = Math.min(minY, p.y); maxY = Math.max(maxY, p.y);
				});
				const rx = (maxX - minX) || 100;
				const ry = (maxY - minY) || 100;
				scale = Math.min(canvas.width / (rx * 1.4), canvas.height / (ry * 1.4));
				scale = Math.min(Math.max(scale, 0.1), 5000);
				offsetX = canvas.width / 2 - ((minX + maxX) / 2) * scale;
				offsetY = canvas.height / 2 + ((minY + maxY) / 2) * scale;
			}
		});
    }

    function initTouchHandlers() {
        let initDist = 0, initScale = scale;
		canvas.addEventListener('touchstart', (e) => {
			e.preventDefault();
			if (e.touches.length === 1) {
				isDragging = true;
				lastMouseX = e.touches[0].clientX; 
				lastMouseY = e.touches[0].clientY;
				
				if (followMode) {
					followMode = false;
					if (btnCenter) {
						btnCenter.classList.remove('active');
						btnCenter.textContent = '⊙';
					}
					setStatus('Слежение выключено (перетаскивание)');
				}
			} else if (e.touches.length === 2) {
				isDragging = false;
				const dx = e.touches[0].clientX - e.touches[1].clientX;
				const dy = e.touches[0].clientY - e.touches[1].clientY;
				initDist = Math.sqrt(dx*dx + dy*dy);
				initScale = scale;
				
				if (followMode) {
					followMode = false;
					if (btnCenter) {
						btnCenter.classList.remove('active');
						btnCenter.textContent = '⊙';
					}
				}
			}
		});
        canvas.addEventListener('touchmove', (e) => {
            e.preventDefault();
            if (e.touches.length === 1 && isDragging) {
                offsetX += e.touches[0].clientX - lastMouseX;
                offsetY += e.touches[0].clientY - lastMouseY;
                lastMouseX = e.touches[0].clientX; lastMouseY = e.touches[0].clientY;
                autoScaleEnabled = false;
            } else if (e.touches.length === 2) {
                const dx = e.touches[0].clientX - e.touches[1].clientX;
                const dy = e.touches[0].clientY - e.touches[1].clientY;
                const dist = Math.sqrt(dx*dx + dy*dy);
                if (initDist > 0) {
                    scale = Math.min(Math.max(initScale * (dist / initDist), 0.1), 5000);
                    autoScaleEnabled = false;
                }
            }
        });
        canvas.addEventListener('touchend', () => { isDragging = false; });
    }

    // ========== ПУБЛИЧНЫЙ API ==========
    return {
        init,
        toggleConnection,
        openSettings, closeSettings, applySettings,
        toggleDropdown, closeAllDropdowns,
        cycleTheme,
        exportCSV, exportCSVStats, exportKML,
        resetStats,
		toggleCenter,
    };

})();

document.addEventListener('DOMContentLoaded', () => App.init());