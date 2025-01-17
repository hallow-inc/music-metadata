"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.WaveParser = void 0;
const strtok3 = require("strtok3/lib/core");
const Token = require("token-types");
const initDebug = require("debug");
const riff = require("../riff/RiffChunk");
const WaveChunk = require("./../wav/WaveChunk");
const ID3v2Parser_1 = require("../id3v2/ID3v2Parser");
const util = require("../common/Util");
const FourCC_1 = require("../common/FourCC");
const BasicParser_1 = require("../common/BasicParser");
const debug = initDebug('music-metadata:parser:RIFF');
/**
 * Resource Interchange File Format (RIFF) Parser
 *
 * WAVE PCM soundfile format
 *
 * Ref:
 *  http://www.johnloomis.org/cpe102/asgn/asgn1/riff.html
 *  http://soundfile.sapp.org/doc/WaveFormat
 *
 *  ToDo: Split WAVE part from RIFF parser
 */
class WaveParser extends BasicParser_1.BasicParser {
    async parse() {
        const riffHeader = await this.tokenizer.readToken(riff.Header);
        debug(`pos=${this.tokenizer.position}, parse: chunkID=${riffHeader.chunkID}`);
        if (riffHeader.chunkID !== 'RIFF')
            return; // Not RIFF format
        return this.parseRiffChunk(riffHeader.chunkSize).catch(err => {
            if (!(err instanceof strtok3.EndOfStreamError)) {
                throw err;
            }
        });
    }
    async parseRiffChunk(chunkSize) {
        const type = await this.tokenizer.readToken(FourCC_1.FourCcToken);
        this.metadata.setFormat('container', type);
        switch (type) {
            case 'WAVE':
                return this.readWaveChunk(chunkSize - FourCC_1.FourCcToken.len);
            default:
                throw new Error(`Unsupported RIFF format: RIFF/${type}`);
        }
    }
    async readWaveChunk(remaining) {
        while (remaining >= riff.Header.len) {
            const header = await this.tokenizer.readToken(riff.Header);
            remaining -= riff.Header.len + header.chunkSize;
            if (header.chunkSize > remaining) {
                this.metadata.addWarning('Data chunk size exceeds file size');
            }
            this.header = header;
            debug(`pos=${this.tokenizer.position}, readChunk: chunkID=RIFF/WAVE/${header.chunkID}`);
            switch (header.chunkID) {
                case 'LIST':
                    await this.parseListTag(header);
                    break;
                case 'fact': // extended Format chunk,
                    this.metadata.setFormat('lossless', false);
                    this.fact = await this.tokenizer.readToken(new WaveChunk.FactChunk(header));
                    break;
                case 'fmt ': // The Util Chunk, non-PCM Formats
                    const fmt = await this.tokenizer.readToken(new WaveChunk.Format(header));
                    let subFormat = WaveChunk.WaveFormat[fmt.wFormatTag];
                    if (!subFormat) {
                        debug('WAVE/non-PCM format=' + fmt.wFormatTag);
                        subFormat = 'non-PCM (' + fmt.wFormatTag + ')';
                    }
                    this.metadata.setFormat('codec', subFormat);
                    this.metadata.setFormat('bitsPerSample', fmt.wBitsPerSample);
                    this.metadata.setFormat('sampleRate', fmt.nSamplesPerSec);
                    this.metadata.setFormat('numberOfChannels', fmt.nChannels);
                    this.metadata.setFormat('bitrate', fmt.nBlockAlign * fmt.nSamplesPerSec * 8);
                    this.blockAlign = fmt.nBlockAlign;
                    break;
                case 'id3 ': // The way Picard, FooBar currently stores, ID3 meta-data
                case 'ID3 ': // The way Mp3Tags stores ID3 meta-data
                    const id3_data = await this.tokenizer.readToken(new Token.Uint8ArrayType(header.chunkSize));
                    const rst = strtok3.fromBuffer(id3_data);
                    await new ID3v2Parser_1.ID3v2Parser().parse(this.metadata, rst, this.options);
                    break;
                case 'data': // PCM-data
                    if (this.metadata.format.lossless !== false) {
                        this.metadata.setFormat('lossless', true);
                    }
                    let chunkSize = header.chunkSize;
                    if (this.tokenizer.fileInfo.size) {
                        const calcRemaining = this.tokenizer.fileInfo.size - this.tokenizer.position;
                        if (calcRemaining < chunkSize) {
                            this.metadata.addWarning('data chunk length exceeding file length');
                            chunkSize = calcRemaining;
                        }
                    }
                    const numberOfSamples = this.fact ? this.fact.dwSampleLength : (chunkSize === 0xffffffff ? undefined : chunkSize / this.blockAlign);
                    if (numberOfSamples) {
                        this.metadata.setFormat('numberOfSamples', numberOfSamples);
                        this.metadata.setFormat('duration', numberOfSamples / this.metadata.format.sampleRate);
                    }
                    this.metadata.setFormat('bitrate', this.metadata.format.numberOfChannels * this.blockAlign * this.metadata.format.sampleRate); // ToDo: check me
                    await this.tokenizer.ignore(header.chunkSize);
                    break;
                case 'cue ': // cue points
                    const cue = await this.tokenizer.readToken(new WaveChunk.Cue(header));
                    cue.points.forEach(cuePoint => this.metadata.addCuePoint(cuePoint));
                    break;
                default:
                    debug(`Ignore chunk: RIFF/${header.chunkID} of ${header.chunkSize} bytes`);
                    this.metadata.addWarning('Ignore chunk: RIFF/' + header.chunkID);
                    await this.tokenizer.ignore(header.chunkSize);
            }
            if (this.metadata.cues) {
                debug(`Cues count: ${this.metadata.cues.length}`);
                if (this.metadata.format) {
                    for (const p of this.metadata.cues) {
                        p.position = (p.dwSampleOffset / this.metadata.format.sampleRate * 1000);
                    }
                }
            }
            if (this.header.chunkSize % 2 === 1) {
                debug('Read odd padding byte'); // https://wiki.multimedia.cx/index.php/RIFF
                await this.tokenizer.ignore(1);
            }
        }
    }
    async parseListTag(listHeader) {
        const listType = await this.tokenizer.readToken(new Token.StringType(4, 'binary'));
        debug('pos=%s, parseListTag: chunkID=RIFF/WAVE/LIST/%s', this.tokenizer.position, listType);
        switch (listType) {
            case 'INFO':
                return this.parseRiffInfoTags(listHeader.chunkSize - 4);
            case 'adtl':
                return this.parseRiffAdtlTags(listHeader.chunkSize - 4);
            default:
                this.metadata.addWarning('Ignore chunk: RIFF/WAVE/LIST/' + listType);
                debug('Ignoring chunkID=RIFF/WAVE/LIST/' + listType);
                return this.tokenizer.ignore(listHeader.chunkSize - 4).then();
        }
    }
    async parseRiffInfoTags(chunkSize) {
        while (chunkSize >= 8) {
            const header = await this.tokenizer.readToken(riff.Header);
            const valueToken = new riff.ListInfoTagValue(header);
            const value = await this.tokenizer.readToken(valueToken);
            this.addTag(header.chunkID, util.stripNulls(value));
            chunkSize -= (8 + valueToken.len);
        }
        if (chunkSize !== 0) {
            throw Error('Illegal remaining size: ' + chunkSize);
        }
    }
    async parseRiffAdtlTags(chunkSize) {
        while (chunkSize >= 8) {
            const header = await this.tokenizer.readToken(riff.Header);
            const valueToken = new riff.ListInfoTagValue(header);
            const value = await this.tokenizer.readToken(valueToken);
            if (header.chunkID === 'labl') {
                this.setCueData('label', value);
            }
            else if (header.chunkID === 'note') {
                this.setCueData('description', value);
            }
            chunkSize -= (8 + valueToken.len);
        }
    }
    setCueData(name, value) {
        for (let c = 0; c < this.metadata.cues.length; c++) {
            const n = this.metadata.cues[c].dwName;
            const regex = new RegExp('^\\x0' + n);
            if (regex.test(value)) {
                this.metadata.cues[c][name] = util.stripNulls(value.replace(regex, ''));
                break;
            }
        }
    }
    addTag(id, value) {
        this.metadata.addTag('exif', id, value);
    }
}
exports.WaveParser = WaveParser;
