// gnss-parser.js — Парсер NMEA для GNSS-компаса
// $HEHDT (True Heading), $HCHDG/$HCHDM (Magnetic Heading), $GPRMC (Position)

const GNSSParser = (() => {

    function safeFloat(str) {
        if (!str || str === '') return NaN;
        const v = parseFloat(str);
        return isNaN(v) ? NaN : v;
    }
	
	function safeInt(str) {
		if (!str || str === '') return NaN;
		const v = parseInt(str, 10);
		return isNaN(v) ? NaN : v;
	}

    function parseRMC(fields) {
        // $GPRMC,time,status,lat,N,lon,E,speed,course,date,mode*CS
        const status = fields[1] || '';
        if (status === 'V' || status === 'Invalid') return null;

        let lat = safeFloat(fields[2]);
        let lon = safeFloat(fields[4]);
        if (isNaN(lat) || isNaN(lon)) return null;

        // Конвертация из ddmm.mmmm в градусы
        if (lat > 0) {
            const latDeg = Math.floor(lat / 100);
            const latMin = lat - latDeg * 100;
            lat = latDeg + latMin / 60;
        }
        if (lon > 0) {
            const lonDeg = Math.floor(lon / 100);
            const lonMin = lon - lonDeg * 100;
            lon = lonDeg + lonMin / 60;
        }

        const latHemi = fields[3] || '';
        const lonHemi = fields[5] || '';
        if (latHemi === 'S') lat = -lat;
        if (lonHemi === 'W') lon = -lon;

        const mode = fields[11] || '';
        if (mode === 'N') return null;

        const speedKnots = safeFloat(fields[6]);
        const course = safeFloat(fields[7]);

        return {
            type: 'rmc',
            latitude: lat,
            longitude: lon,
            speedMps: !isNaN(speedKnots) ? speedKnots * 0.514444 : NaN,
            course: !isNaN(course) ? course : NaN,
        };
    }
	
	function parseGGA(fields) {
		const quality = parseInt(fields[5]) || 0;
		if (quality === 0) return null;

		let lat = safeFloat(fields[1]);
		let lon = safeFloat(fields[3]);
		if (isNaN(lat) || isNaN(lon)) return null;

		if (lat > 0) {
			const latDeg = Math.floor(lat / 100);
			const latMin = lat - latDeg * 100;
			lat = latDeg + latMin / 60;
		}
		if (lon > 0) {
			const lonDeg = Math.floor(lon / 100);
			const lonMin = lon - lonDeg * 100;
			lon = lonDeg + lonMin / 60;
		}

		const latHemi = fields[2] || '';
		const lonHemi = fields[4] || '';
		if (latHemi === 'S') lat = -lat;
		if (lonHemi === 'W') lon = -lon;

		const numSV = parseInt(fields[6]) || 0;
		const hdop = safeFloat(fields[7]);
		const alt = safeFloat(fields[8]);

		return {
			type: 'gga',
			latitude: lat,
			longitude: lon,
			altitude: !isNaN(alt) ? alt : NaN,
			speedMps: NaN,
			course: NaN,
			numSV: !isNaN(numSV) ? numSV : 0,
			hdop: !isNaN(hdop) ? hdop : NaN,
			quality: quality,
		};
	}

    function parseHDT(fields) {
        // $HEHDT,heading,T*CS
        const heading = safeFloat(fields[0]);
        if (isNaN(heading)) return null;

        return {
            type: 'hdt',
            heading: heading,
            isTrue: true,
        };
    }

    function parseHDG(fields) {
        // $HCHDG,heading,deviation,var,var_dir*CS
        const heading = safeFloat(fields[0]);
        if (isNaN(heading)) return null;

        return {
            type: 'hdm',
            heading: heading,
            isTrue: false,
        };
    }

    function parseHDM(fields) {
        // $HCHDM,heading,M*CS
        const heading = safeFloat(fields[0]);
        if (isNaN(heading)) return null;

        return {
            type: 'hdm',
            heading: heading,
            isTrue: false,
        };
    }
	
	function parseGSA(fields) {
		// $GPGSA,mode,fixType,sv1...sv12,pdop,hdop,vdop*CS
		const mode = fields[0] || '';
		const fixType = parseInt(fields[1]) || 0;
		const pdop = safeFloat(fields[14]);
		const hdop = safeFloat(fields[15]);
		const vdop = safeFloat(fields[16]);

		return {
			type: 'gsa',
			mode,
			fixType,
			pdop: !isNaN(pdop) ? pdop : NaN,
			hdop: !isNaN(hdop) ? hdop : NaN,
			vdop: !isNaN(vdop) ? vdop : NaN,
		};
	}

	function parse(rawLine) {
		if (typeof rawLine !== 'string') return null;
		const line = rawLine.trim();
		if (!line.startsWith('$')) return null;

		const body = line.substring(1).split('*')[0];
		const parts = body.split(',');
		const talker = parts[0];

		// Извлекаем тип предложения — последние 3 буквы после talker
		// Работает для любых префиксов: GP, GN, GL, GA, HE, HC, OUT, и т.д.
		const sentenceType = talker.slice(-3).toUpperCase();

		if (sentenceType === 'HDT') return parseHDT(parts.slice(1));
		if (sentenceType === 'HDG') return parseHDG(parts.slice(1));
		if (sentenceType === 'HDM') return parseHDM(parts.slice(1));
		if (sentenceType === 'RMC') return parseRMC(parts.slice(1));
		if (sentenceType === 'GGA') return parseGGA(parts.slice(1));
		if (sentenceType === 'GSA') return parseGSA(parts.slice(1));

		return null;
	}

    return { parse, safeFloat };
})();

if (typeof module !== 'undefined' && module.exports) {
    module.exports = GNSSParser;
}