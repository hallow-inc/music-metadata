'use strict';

import ReadableStream = NodeJS.ReadableStream;

import {ITokenizer, EndOfFile} from "strtok3";
import {IFormat} from "../src";
import Common from "./common";
import * as Token from "token-types";
import {StringType, BufferType} from "token-types";
import {Promise} from "es6-promise";

/**
 * MPEG Audio Layer I/II/III frame header
 * Ref: https://www.mp3-tech.org/programmer/frame_header.html
 * Bit layout: AAAAAAAA AAABBCCD EEEEFFGH IIJJKLMM
 */
class MpegFrameHeader {

  public static SyncByte1 = 0xFF;
  public static SyncByte2 = 0xE0;

  public static VersionID = [2.5, null, 2, 1];
  public static LayerDescription = [null, 3, 2, 1];
  public static ChannelMode = ['stereo', 'joint_stereo', 'dual_channel', 'mono'];

  private static bitrate_index = {
    0x01: {11: 32, 12: 32, 13: 32, 21: 32, 22: 8, 23: 8},
    0x02: {11: 64, 12: 48, 13: 40, 21: 48, 22: 16, 23: 16},
    0x03: {11: 96, 12: 56, 13: 48, 21: 56, 22: 24, 23: 24},
    0x04: {11: 128, 12: 64, 13: 56, 21: 64, 22: 32, 23: 32},
    0x05: {11: 160, 12: 80, 13: 64, 21: 80, 22: 40, 23: 40},
    0x06: {11: 192, 12: 96, 13: 80, 21: 96, 22: 48, 23: 48},
    0x07: {11: 224, 12: 112, 13: 96, 21: 112, 22: 56, 23: 56},
    0x08: {11: 256, 12: 128, 13: 112, 21: 128, 22: 64, 23: 64},
    0x09: {11: 288, 12: 160, 13: 128, 21: 144, 22: 80, 23: 80},
    0x0A: {11: 320, 12: 192, 13: 160, 21: 160, 22: 96, 23: 96},
    0x0B: {11: 352, 12: 224, 13: 192, 21: 176, 22: 112, 23: 112},
    0x0C: {11: 384, 12: 256, 13: 224, 21: 192, 22: 128, 23: 128},
    0x0D: {11: 416, 12: 320, 13: 256, 21: 224, 22: 144, 23: 144},
    0x0E: {11: 448, 12: 384, 13: 320, 21: 256, 22: 160, 23: 160}
  };

  private static sampling_rate_freq_index = {
    1: {0x00: 44100, 0x01: 48000, 0x02: 32000},
    2: {0x00: 22050, 0x01: 24000, 0x02: 16000},
    2.5: {0x00: 11025, 0x01: 12000, 0x02: 8000}
  };

  private static samplesInFrameTable = [
  /* Layer   I    II   III */
    [0, 384, 1152, 1152], // MPEG-1
    [0, 384, 1152, 576] // MPEG-2(.5
  ];

  // B(20,19): MPEG Audio versionIndex ID
  public versionIndex: number;
  // C(18,17): Layer description
  public layerIndex: number;
  // D(16): Protection bit
  public isProtectedByCRC: boolean;
  // E(15,12): Bitrate index
  public bitrateIndex: number;
  // F(11,10): Sampling rate frequency index
  public sampRateFreqIndex: number;
  // G(9): Padding bit
  public padding: boolean;
  // H(8): Private bit
  public privateBit: boolean;
  // I(7,6): Channel Mode
  public channelModeIndex: number;
  // J(5,4): Mode extension (Only used in Joint stereo)
  public modeExtension: number;
  // K(3): Copyright
  public isCopyrighted: boolean;
  // L(2): Original
  public isOriginalMedia: boolean;
  // M(3): The original bit indicates, if it is set, that the frame is located on its original media.
  public emphasis: number;

  public layer: number;
  public version: number;
  public channelMode: string;
  public bitrate: number;
  public samplingRate: number;

  public constructor(buf, off) {
    // B(20,19): MPEG Audio versionIndex ID
    this.versionIndex = Common.getBitAllignedNumber(buf, off + 1, 3, 2);
    // C(18,17): Layer description
    this.layer = MpegFrameHeader.LayerDescription[Common.getBitAllignedNumber(buf, off + 1, 5, 2)];

    if (this.layer === null)
      throw new Error('Invalid MPEG layer');

    // D(16): Protection bit (if true 16-bit CRC follows header)
    this.isProtectedByCRC = !Common.isBitSet(buf, off + 1, 7);
    // E(15,12): Bitrate index
    this.bitrateIndex = Common.getBitAllignedNumber(buf, off + 2, 0, 4);
    // F(11,10): Sampling rate frequency index
    this.sampRateFreqIndex = Common.getBitAllignedNumber(buf, off + 2, 4, 2);
    // G(9): Padding bit
    this.padding = Common.isBitSet(buf, off + 2, 6);
    // H(8): Private bit
    this.privateBit = Common.isBitSet(buf, off + 2, 7);
    // I(7,6): Channel Mode
    this.channelModeIndex = Common.getBitAllignedNumber(buf, off + 3, 0, 2);
    // J(5,4): Mode extension (Only used in Joint stereo)
    this.modeExtension = Common.getBitAllignedNumber(buf, off + 3, 2, 2);
    // K(3): Copyright
    this.isCopyrighted = Common.isBitSet(buf, off + 3, 4);
    // L(2): Original
    this.isOriginalMedia = Common.isBitSet(buf, off + 3, 5);
    // M(3): The original bit indicates, if it is set, that the frame is located on its original media.
    this.emphasis = Common.getBitAllignedNumber(buf, off + 3, 7, 2);

    this.version = MpegFrameHeader.VersionID[this.versionIndex];

    if (this.version === null)
      throw new Error('Invalid MPEG Audio version');

    this.channelMode = MpegFrameHeader.ChannelMode[this.channelModeIndex];

    // Calculate bitrate
    const bitrateInKbps = this.calcBitrate();
    if (!bitrateInKbps) {
      throw new Error('Cannot determine bit-rate');
    }
    this.bitrate = bitrateInKbps === null ? null : bitrateInKbps * 1000;

    // Calculate sampling rate
    this.samplingRate = this.calcSamplingRate();
    if (this.samplingRate == null) {
      throw new Error('Cannot determine sampling-rate');
    }
  }

  public calcDuration(numFrames): number {
    return Math.round(numFrames * (this.calcSamplesPerFrame() / this.samplingRate));
  }

  public calcSamplesPerFrame(): number {
    return MpegFrameHeader.samplesInFrameTable[this.version === 1 ? 0 : 1][this.layer];
  }

  public calculateSideInfoLength(): number {
    if (this.layer !== 3) return 2;
    if (this.channelModeIndex === 3) {
      // mono
      if (this.version === 1) {
        return 17;
      } else if (this.version === 2 || this.version === 2.5) {
        return 9;
      }
    } else {
      if (this.version === 1) {
        return 32;
      } else if (this.version === 2 || this.version === 2.5) {
        return 17;
      }
    }
  }

  public calcSlotSize(): number {
    return [null, 4, 1, 1][this.layer];
  }

  private calcBitrate(): number {
    if (this.bitrateIndex === 0x00) return null; // free
    if (this.bitrateIndex === 0x0F) return null; // 'reserved'
    const mpegVersion: string = this.version.toString() + this.layer;
    return MpegFrameHeader.bitrate_index[this.bitrateIndex][mpegVersion];
  }

  private calcSamplingRate(): number {
    if (this.sampRateFreqIndex === 0x03) return null; // 'reserved'
    return MpegFrameHeader.sampling_rate_freq_index[this.version][this.sampRateFreqIndex];
  }
}

interface IXingInfoTag {

  headerFlags: Buffer,

  /**
   * total bit stream frames from Vbr header data
   */
  numFrames: number,

  numToCentries: Buffer,

  /**
   * the number of header APE_HEADER bytes
   */
  streamSize: number,

  /**
   * the number of header data bytes (from original file)
   */
  vbrScale: number,

  /**
   * LAME Tag, extends the Xing header format
   * First added in LAME 3.12 for VBR
   * The modified header is also included in CBR files (effective LAME 3.94), with "Info" instead of "XING" near the beginning.
   */

  //  Initial LAME info, e.g.: LAME3.99r
  encoder: string,
  /**
   * Info Tag
   */
  infoTag: number,
  /**
   * VBR method
   */
  vbrMethod: number;
}

/**
 * MPEG Audio Layer I/II/III
 */
class MpegAudioLayer {

  public static FrameHeader = {
    len: 4,

    get: (buf, off): MpegFrameHeader => {
      return new MpegFrameHeader(buf, off);
    }
  };

  /**
   * Info Tag: Xing, LAME
   */
  public static InfoTagHeaderTag = new StringType(4, 'ascii');

  /**
   * LAME TAG value
   * Did not find any official documentation for this
   * Value e.g.: "3.98.4"
   */
  public static LameEncoderVersion = new StringType(6, 'ascii');

  /**
   * Info Tag
   * Ref: http://gabriel.mp3-tech.org/mp3infotag.html
   */
  public static XingInfoTag: Token.IGetToken<IXingInfoTag> = {
    len: 136,

    get: (buf, off) => {
      return {
        // 4 bytes for HeaderFlags
        headerFlags: new BufferType(4).get(buf, off),

        // 100 bytes for entry (NUMTOCENTRIES)
        // numToCentries: new strtok.BufferType(100).get(buf, off + 8),
        // FRAME SIZE
        // frameSize: strtok.UINT32_BE.get(buf, off + 108),

        numFrames: Token.UINT32_BE.get(buf, off + 4),

        numToCentries: new BufferType(100).get(buf, off + 104),

        // the number of header APE_HEADER bytes
        streamSize: Token.UINT32_BE.get(buf, off + 108),
        // the number of header data bytes (from original file)
        vbrScale: Token.UINT32_BE.get(buf, off + 112),

        /**
         * LAME Tag, extends the Xing header format
         * First added in LAME 3.12 for VBR
         * The modified header is also included in CBR files (effective LAME 3.94), with "Info" instead of "XING" near the beginning.
         */

        //  Initial LAME info, e.g.: LAME3.99r
        encoder: new StringType(9, 'ascii').get(buf, off + 116),
        //  Info Tag
        infoTag: Token.UINT8.get(buf, off + 125) >> 4,
        // VBR method
        vbrMethod: Token.UINT8.get(buf, off + 125) & 0xf
      };
    }
  };

  public static getVbrCodecProfile(vbrScale: number): string {
    return 'V' + (100 - vbrScale) / 10;
  }
}

export class MpegParser {

  private frameCount: number = 0;
  private countSkipFrameData: number = 0;

  private audioFrameHeader;
  private bitrates: number[] = [];
  private offset: number;
  private frame_size;
  private crc: number;
  private unsynced: number = 0;
  private warnings: string[] = [];

  private calculateVbrDuration: boolean = false;
  private samplesPerFrame;

  private format: IFormat;

  private buf_frame_header = new Buffer(4);

  public constructor(private tokenizer: ITokenizer, private headerSize: number, private readDuration: boolean) {
  }

  public parse(): Promise<IFormat> {

    this.format = {
      dataformat: 'mp3',
      lossless: false
    };

    return this.sync().then(() => {
      return this.format;
    }).catch((err) => {
      if (err === EndOfFile)
        if (this.calculateVbrDuration) {
          if (this.samplesPerFrame) {
            this.format.numberOfSamples = this.frameCount * this.samplesPerFrame; // -529 (1152-529)=623
            this.format.duration = this.format.numberOfSamples / this.format.sampleRate;
          }
        }
      return this.format;
    });
  }

  public sync(): Promise<void> {
    return this.tokenizer.readBuffer(this.buf_frame_header, 0, 1).then(() => {
      if (this.buf_frame_header[0] === MpegFrameHeader.SyncByte1) {
        return this.tokenizer.readBuffer(this.buf_frame_header, 1, 1).then(() => {
          if ((this.buf_frame_header[1] & 0xE0) === 0xE0) {
            // Synchronized
            this.warnings.push("synchronized, after " + this.unsynced + " bytes of unsynced data");
            this.unsynced = 0;
            return this.parseAudioFrameHeader(this.buf_frame_header);
          } else {
            this.unsynced += 2;
            return this.sync();
          }
        });
      } else {
        ++this.unsynced;
        return this.sync();
      }
    });
  }

  public parseAudioFrameHeader(buf_frame_header: Buffer): Promise<void> {

    return this.tokenizer.readBuffer(buf_frame_header, 2, 2).then(() => {

      let header: MpegFrameHeader;
      try {
        header = MpegAudioLayer.FrameHeader.get(buf_frame_header, 0);
      } catch (err) { // ToDO: register warning
        this.warnings.push("Parse error: " + err.message);
        return this.sync();
      }

      // mp3 files are only found in MPEG1/2 Layer 3
      if (( header.version !== 1 && header.version !== 2) || header.layer !== 3) {
        this.warnings.push("Parse error:  mp3 files are only found in MPEG1/2 Layer 3");
        return this.sync();
      }

      this.format.dataformat = 'mp3';
      this.format.lossless = false;

      this.format.bitrate = header.bitrate;
      this.format.sampleRate = header.samplingRate;
      this.format.numberOfChannels = header.channelMode === 'mono' ? 1 : 2;

      const slot_size = header.calcSlotSize();
      if (slot_size === null) {
        throw new Error('invalid slot_size');
      }

      const samples_per_frame = header.calcSamplesPerFrame();
      const bps = samples_per_frame / 8.0;
      const fsize = (bps * header.bitrate / header.samplingRate) +
        ((header.padding) ? slot_size : 0);
      this.frame_size = Math.floor(fsize);

      this.audioFrameHeader = header;
      this.frameCount++;
      this.bitrates.push(header.bitrate);
      // debug("frame#=%s, bitrate=%s, sampleRate=%s, samplesPerFrame=%s, numberOfChannels=%s, frame-size=%s", this.frameCount, this.format.bitrate, this.format.sampleRate, samples_per_frame, this.format.numberOfChannels, this.frame_size);

      // xtra header only exists in first frame
      if (this.frameCount === 1) {
        this.offset = MpegAudioLayer.FrameHeader.len;
        return this.skipSideInformation();
      }

      if (this.frameCount === 3) {
        // the stream is CBR if the first 3 frame bitrates are the same
        if (this.areAllSame(this.bitrates)) {
          // subtract non audio stream data from duration calculation
          const size = this.tokenizer.fileSize - this.headerSize;
          this.format.duration = (size * 8) / header.bitrate;
          this.format.codecProfile = "CBR";
          return; // Done
        } else if (!this.readDuration) {
          // debug("duration=false => done.");
          return; // Done
        }
      }

      // once we know the file is VBR attach listener to end of
      // stream so we can do the duration calculation when we
      // have counted all the frames
      if (this.readDuration && this.frameCount === 4) {
        this.samplesPerFrame = samples_per_frame;
        this.calculateVbrDuration = true;
      }

      this.offset = 4;
      if (header.isProtectedByCRC) {
        return this.parseCrc();
      } else {
        return this.skipSideInformation();
      }
    });
  }

  public parseCrc(): Promise<void> {
    this.tokenizer.readNumber(Token.INT16_BE).then((crc) => {
      this.crc = crc;
    });
    this.offset += 2;
    return this.skipSideInformation();
  }

  public skipSideInformation(): Promise<void> {
    const sideinfo_length = this.audioFrameHeader.calculateSideInfoLength();
    // side information
    return this.tokenizer.readToken(new BufferType(sideinfo_length)).then(() => {
      this.offset += sideinfo_length;
      return this.readXtraInfoHeader();
    });
  }

  public readXtraInfoHeader(): Promise<any> {

    return this.tokenizer.readToken(MpegAudioLayer.InfoTagHeaderTag).then((headerTag) => {
      this.offset += MpegAudioLayer.InfoTagHeaderTag.len;  // 12

      switch (headerTag) {

        case 'Info':
          this.format.codecProfile = 'CBR';
          return this.readXingInfoHeader();

        case 'Xing':
          return this.readXingInfoHeader().then((infoTag) => {
            this.format.codecProfile = MpegAudioLayer.getVbrCodecProfile(infoTag.vbrScale);
            return null;
          });

        case 'Xtra':
          // ToDo: ???
          break;

        case 'LAME':
          return this.tokenizer.readToken(MpegAudioLayer.LameEncoderVersion).then((version) => {
            this.offset += MpegAudioLayer.LameEncoderVersion.len;
            this.format.encoder = "LAME " + version;
            const frameDataLeft = this.frame_size - this.offset;
            return this.skipFrameData(frameDataLeft);
          });
        // ToDo: ???
      }

      // ToDo: promise duration???
      const frameDataLeft = this.frame_size - this.offset;
      return this.skipFrameData(frameDataLeft);
    });
  }

  /**
   * Ref: http://gabriel.mp3-tech.org/mp3infotag.html
   * @returns {Promise<string>}
   */
  private readXingInfoHeader(): Promise<IXingInfoTag> {

    return this.tokenizer.readToken<IXingInfoTag>(MpegAudioLayer.XingInfoTag).then((infoTag) => {
      this.offset += MpegAudioLayer.XingInfoTag.len;  // 12

      this.format.encoder = Common.stripNulls(infoTag.encoder);

      if ((infoTag.headerFlags[3] & 0x01) === 1) {
        this.format.duration = this.audioFrameHeader.calcDuration(infoTag.numFrames);
        return infoTag; // Done
      }

      // frames field is not present
      const frameDataLeft = this.frame_size - this.offset;

      // ToDo: promise duration???
      return this.skipFrameData(frameDataLeft).then(() => {
        return infoTag;
      });
    });
  }

  private countDataFrames: number = 0;

  private skipFrameData(frameDataLeft: number): Promise<void> {
    //return this.tokenizer.readToken(new Token.IgnoreType(frameDataLeft)).then(() => {
    return this.tokenizer.readToken(new Token.IgnoreType(frameDataLeft)).then(() => {
      this.countDataFrames = frameDataLeft;
      this.countSkipFrameData += frameDataLeft;
      return this.sync();
    });
  }

  private areAllSame(array) {
    const first = array[0];
    return array.every((element) => {
      return element === first;
    });
  }
}
