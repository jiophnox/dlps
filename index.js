import { TelegramClient } from "telegram";
import { StringSession } from "telegram/sessions/index.js";
import { NewMessage } from "telegram/events/index.js";
import dotenv from "dotenv";
import path from "path";
import fs from "fs";
import axios from "axios";
import { fileURLToPath } from "url";
import { dirname } from "path";
import { Api } from "telegram";
import express from "express";
import { Innertube } from "youtubei.js";
import { promisify } from "util";
import { exec, spawn } from "child_process";

const execPromise = promisify(exec);

import ffmpegPath from "@ffmpeg-installer/ffmpeg";
import ffprobePath from "@ffprobe-installer/ffprobe";

const app = express();
const PORT = process.env.PORT || 3000;

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

dotenv.config();

process.env.FFMPEG_PATH = ffmpegPath.path;
process.env.FFPROBE_PATH = ffprobePath.path;

console.log("✅ FFmpeg path:", ffmpegPath.path);
console.log("✅ FFprobe path:", ffprobePath.path);

const API_ID = parseInt(process.env.API_ID);
const API_HASH = process.env.API_HASH;
const BOT_TOKEN = process.env.BOT_TOKEN;
const MAX_FILE_SIZE = parseInt(process.env.MAX_FILE_SIZE) || 2000;

const stringSession = new StringSession("");

const client = new TelegramClient(stringSession, API_ID, API_HASH, {
  connectionRetries: 5,
});

const tempDir = path.join(__dirname, "temp");
if (!fs.existsSync(tempDir)) {
  fs.mkdirSync(tempDir);
}

const activeDownloads = new Map();
const urlCache = new Map();
const playlistCache = new Map();
const activeTasks = new Map();

// ===========================
// ✅ Helper Functions
// ===========================

function isValidYouTubeUrl(url) {
  const youtubeRegex = /^(https?:\/\/)?(www\.)?(youtube\.com|youtu\.be)\/.+/;
  return youtubeRegex.test(url);
}

function isPlaylistUrl(url) {
  return url.includes("list=");
}

function extractPlaylistId(url) {
  const match = url.match(/[?&]list=([^&]+)/);
  return match ? match[1] : null;
}

function parsePlaylistInput(text) {
  const parts = text.split("|").map((p) => p.trim());

  if (parts.length === 1) {
    return {
      url: parts[0],
      startIndex: null,
      endIndex: null,
    };
  }

  const url = parts[0];
  const range = parts[1];

  if (range.includes("-")) {
    const [start, end] = range.split("-").map((n) => parseInt(n.trim()));
    return { url, startIndex: start, endIndex: end };
  } else {
    const start = parseInt(range);
    return { url, startIndex: start, endIndex: null };
  }
}

function sanitizeFilename(filename, maxBytes = 240) {
  let cleaned = filename.replace(/[/\\?%*:|"<>]/g, "-");
  const byteLength = Buffer.byteLength(cleaned, "utf8");

  if (byteLength <= maxBytes) {
    return cleaned;
  }

  let truncated = cleaned;
  while (Buffer.byteLength(truncated, "utf8") > maxBytes - 3) {
    truncated = truncated.slice(0, -1);
  }

  return truncated.trim() + "...";
}

function formatFileSize(bytes) {
  const numBytes = typeof bytes === "bigint" ? Number(bytes) : bytes;

  if (!numBytes || numBytes === 0 || isNaN(numBytes)) {
    return "0 Bytes";
  }

  const k = 1024;
  const sizes = ["Bytes", "KB", "MB", "GB"];
  const i = Math.floor(Math.log(numBytes) / Math.log(k));
  const size = (numBytes / Math.pow(k, i)).toFixed(2);

  return `${size} ${sizes[i]}`;
}

function formatDuration(seconds) {
  if (!seconds) return "Unknown";
  const mins = Math.floor(seconds / 60);
  const secs = seconds % 60;
  return `${mins}:${secs.toString().padStart(2, "0")}`;
}

function createProgressBar(percentage) {
  const validPercentage = isNaN(percentage)
    ? 0
    : Math.min(Math.max(percentage, 0), 100);

  const totalCubes = 10;
  const filledCubes = Math.floor((validPercentage / 100) * totalCubes);
  const emptyCubes = totalCubes - filledCubes;

  const filled = "🟦".repeat(filledCubes);
  const empty = "⬜".repeat(emptyCubes);

  return `${filled}${empty} ${validPercentage}%`;
}

async function downloadThumbnailToBuffer(thumbnailUrl) {
  try {
    const response = await axios({
      url: thumbnailUrl,
      method: "GET",
      responseType: "arraybuffer",
      timeout: 15000,
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
      },
    });
    return Buffer.from(response.data);
  } catch (error) {
    console.error("Thumbnail download error:", error.message);
    return null;
  }
}

function createQualityButtons(cacheKey, isPlaylist = false) {
  const prefix = isPlaylist ? "pl_quality" : "quality";
  return [
    [
      new Api.KeyboardButtonCallback({
        text: "🎵 MP3 Audio",
        data: Buffer.from(`${prefix}_mp3_${cacheKey}`),
      }),
      new Api.KeyboardButtonCallback({
        text: "📹 360p",
        data: Buffer.from(`${prefix}_360_${cacheKey}`),
      }),
    ],
    [
      new Api.KeyboardButtonCallback({
        text: "📹 480p",
        data: Buffer.from(`${prefix}_480_${cacheKey}`),
      }),
      new Api.KeyboardButtonCallback({
        text: "📹 720p",
        data: Buffer.from(`${prefix}_720_${cacheKey}`),
      }),
    ],
    [
      new Api.KeyboardButtonCallback({
        text: "📹 1080p",
        data: Buffer.from(`${prefix}_1080_${cacheKey}`),
      }),
    ],
  ];
}

function createPlaylistCancelButtons(userId) {
  return [
    [
      new Api.KeyboardButtonCallback({
        text: "⏭️ Skip Current Video",
        data: Buffer.from(`skip_current_${userId}`),
      }),
    ],
    [
      new Api.KeyboardButtonCallback({
        text: "🛑 Cancel Entire Playlist",
        data: Buffer.from(`cancel_playlist_${userId}`),
      }),
    ],
  ];
}

async function cleanupTask(userId, filePath = null, thumbPath = null) {
  activeTasks.delete(userId);
  activeDownloads.delete(userId);

  if (filePath && fs.existsSync(filePath)) {
    try {
      fs.unlinkSync(filePath);
      console.log(`🗑️ Deleted file: ${filePath}`);
    } catch (e) {
      console.error(`❌ Failed to delete file: ${e.message}`);
    }
  }

  if (thumbPath && fs.existsSync(thumbPath)) {
    try {
      fs.unlinkSync(thumbPath);
      console.log(`🗑️ Deleted thumbnail: ${thumbPath}`);
    } catch (e) {
      console.error(`❌ Failed to delete thumbnail: ${e.message}`);
    }
  }
}

function getOptimalUploadSettings(fileSize) {
  const fileSizeMB = fileSize / (1024 * 1024);

  if (fileSizeMB < 10) {
    return { workers: 8, requestSize: 524288 };
  } else if (fileSizeMB < 50) {
    return { workers: 8, requestSize: 524288 };
  } else if (fileSizeMB < 200) {
    return { workers: 16, requestSize: 524288 };
  } else {
    return { workers: 16, requestSize: 524288 };
  }
}

async function convertToMP3(inputPath, outputPath) {
  try {
    console.log("🔧 Converting to MP3...");

    const command = `"${ffmpegPath.path}" -i "${inputPath}" -vn -ar 44100 -ac 2 -b:a 192k -y "${outputPath}"`;

    await execPromise(command);

    console.log("✅ Conversion complete");
    return true;
  } catch (error) {
    console.error("⚠️ Conversion failed:", error.message);
    return false;
  }
}

// ===========================
// 🚀 ULTRA FAST: Direct yt-dlp Binary Integration
// ===========================

// ✅ Update getYtDlpPath function in index.js

function getYtDlpPath() {
  // Priority order for Render deployment
  const possiblePaths = [
    process.env.YTDLP_PATH, // /opt/render/project/src/bin/yt-dlp
    path.join(__dirname, 'bin', 'yt-dlp'), // ./bin/yt-dlp
    '/opt/render/project/src/bin/yt-dlp', // Render absolute path
    'yt-dlp', // System PATH
    '/usr/local/bin/yt-dlp',
    '/usr/bin/yt-dlp',
  ];
  
  for (const p of possiblePaths) {
    if (!p) continue;
    
    try {
      if (fs.existsSync(p)) {
        console.log(`✅ Found yt-dlp at: ${p}`);
        // Make executable
        try {
          fs.chmodSync(p, 0o755);
        } catch (e) {
          // Ignore chmod errors
        }
        return p;
      }
    } catch (e) {
      // Continue checking
    }
  }
  
  console.log("⚠️ Using default 'yt-dlp' (must be in PATH)");
  return 'yt-dlp';
}

async function getVideoInfoFast(url) {
  return new Promise((resolve, reject) => {
    const args = [
      url,
      "-j", // JSON output
      "--no-warnings",
      "--no-playlist",
      "--skip-download",
      "--user-agent",
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
    ];

    console.log(`🔍 Fetching video info: ${getYtDlpPath()} ${args.join(" ")}`);

    const ytdlp = spawn(getYtDlpPath(), args);

    let jsonData = "";
    let errorData = "";

    ytdlp.stdout.on("data", (data) => {
      jsonData += data.toString();
    });

    ytdlp.stderr.on("data", (data) => {
      errorData += data.toString();
    });

    ytdlp.on("close", (code) => {
      if (code !== 0) {
        reject(new Error(`yt-dlp error: ${errorData}`));
        return;
      }

      try {
        const info = JSON.parse(jsonData);

        console.log("✅ Video info fetched:", info.title);
        console.log(`📊 Duration: ${formatDuration(info.duration)}`);

        const thumbnail =
          info.thumbnails?.find((t) => t.url?.includes("maxresdefault"))?.url ||
          info.thumbnail;

        resolve({
          title: info.title || "Unknown",
          duration: info.duration || 0,
          uploader: info.channel || info.uploader || "Unknown",
          thumbnail: thumbnail,
          url: url,
        });
      } catch (e) {
        reject(new Error(`Failed to parse JSON: ${e.message}`));
      }
    });

    ytdlp.on("error", (err) => {
      reject(new Error(`Failed to spawn yt-dlp: ${err.message}`));
    });
  });
}

async function downloadWithYtDlp(
  url,
  outputTemplate,
  formatSelector,
  progressCallback,
  cancelToken
) {
  return new Promise((resolve, reject) => {
    const args = [
      url,
      "-f",
      formatSelector,
      "-o",
      outputTemplate,
      "--no-warnings",
      "--no-playlist",
      "--newline", // Progress on new lines
      "--merge-output-format",
      "mp4", // ✅ Force merge to MP4
      "--user-agent",
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
      "--concurrent-fragments",
      "4",
      "--throttled-rate",
      "100K",
    ];

    console.log(
      `📥 Download command: ${getYtDlpPath()} -f ${formatSelector} -o ${outputTemplate}`
    );

    const ytdlp = spawn(getYtDlpPath(), args);

    let lastProgress = 0;
    let lastUpdateTime = Date.now();
    let downloadedFile = null;

    ytdlp.stdout.on("data", (data) => {
      if (cancelToken?.cancelled) {
        ytdlp.kill("SIGTERM");
        reject(new Error("cancelled"));
        return;
      }

      const output = data.toString();

      // Parse progress: [download]  45.2% of 10.5MiB at 2.3MiB/s ETA 00:03
      const progressMatch = output.match(/\[download\]\s+(\d+\.?\d*)%/);
      if (progressMatch && progressCallback) {
        const progress = parseFloat(progressMatch[1]);

        const sizeMatch = output.match(/of\s+([\d.]+)(Ki|Mi|Gi)B/);
        const speedMatch = output.match(/at\s+([\d.]+)(Ki|Mi|Gi)B\/s/);
        const etaMatch = output.match(/ETA\s+(\d+:\d+)/);

        const now = Date.now();
        if (
          now - lastUpdateTime >= 1000 ||
          Math.abs(progress - lastProgress) >= 1
        ) {
          lastUpdateTime = now;
          lastProgress = progress;

          const totalSize = sizeMatch
            ? `${sizeMatch[1]} ${sizeMatch[2]}B`
            : "unknown";
          const speed = speedMatch
            ? `${speedMatch[1]} ${speedMatch[2]}B/s`
            : "calculating...";
          const eta = etaMatch ? etaMatch[1] : "unknown";

          progressCallback(progress, totalSize, speed, eta);
        }
      }

      // ✅ Capture final merged filename
      const mergeMatch = output.match(/\[Merger\] Merging formats into "(.+)"/);
      if (mergeMatch) {
        downloadedFile = mergeMatch[1].trim();
        console.log(`✅ Merged file: ${downloadedFile}`);
      }

      // Capture downloaded filename
      const fileMatch = output.match(/\[download\] Destination: (.+)/);
      if (fileMatch && !downloadedFile) {
        downloadedFile = fileMatch[1].trim();
      }
    });

    ytdlp.stderr.on("data", (data) => {
      const error = data.toString();
      // Only log critical errors
      if (
        !error.includes("WARNING") &&
        !error.includes("Deleting original file")
      ) {
        console.error("yt-dlp stderr:", error);
      }
    });

    ytdlp.on("close", (code) => {
      if (cancelToken?.cancelled) {
        reject(new Error("cancelled"));
        return;
      }

      if (code !== 0) {
        reject(new Error(`yt-dlp exited with code ${code}`));
      } else {
        console.log("✅ Download complete");
        resolve(downloadedFile);
      }
    });

    ytdlp.on("error", (err) => {
      reject(new Error(`Failed to spawn yt-dlp: ${err.message}`));
    });
  });
}

// ===========================
// 🚀 ULTRA FAST: Download MP3
// ===========================

async function downloadMP3(url, chatId, messageId, statusMessage, userId) {
  let audioPath = null;
  let tempPath = null;
  let thumbPath = null;
  let lastUpdateTime = Date.now();
  let isCancelled = false;

  const cancelToken = { cancelled: false };
  activeTasks.set(userId, {
    type: "mp3",
    cancel: () => {
      cancelToken.cancelled = true;
      isCancelled = true;
    },
    statusMessage,
    filePath: null,
  });

  try {
    const videoInfo = await getVideoInfoFast(url);

    if (cancelToken.cancelled) throw new Error("cancelled");

    await statusMessage.edit({
      text:
        `🎵 <b>${videoInfo.title}</b>\n\n` +
        `👤 Channel: ${videoInfo.uploader}\n` +
        `⏱ Duration: ${formatDuration(videoInfo.duration)}\n\n` +
        `⬇️ Downloading audio...\n` +
        createProgressBar(0),
      parseMode: "html",
    });

    const sanitizedTitle = sanitizeFilename(videoInfo.title);
    const timestamp = Date.now();
    const outputTemplate = path.join(
      tempDir,
      `${sanitizedTitle}_${timestamp}.%(ext)s`
    );

    const task = activeTasks.get(userId);
    if (task) task.filePath = outputTemplate;

    console.log("⬇️ Starting MP3 download with yt-dlp...");

    // Download best audio and let yt-dlp handle it
    const downloadedFile = await downloadWithYtDlp(
      url,
      outputTemplate,
      "bestaudio[ext=m4a]/bestaudio/best",
      (progress, totalSize, speed, eta) => {
        if (cancelToken.cancelled) return;

        const now = Date.now();
        if (now - lastUpdateTime >= 2000) {
          lastUpdateTime = now;

          statusMessage
            .edit({
              text:
                `🎵 <b>${videoInfo.title}</b>\n\n` +
                `⬇️ Downloading audio...\n` +
                createProgressBar(Math.floor(progress)) +
                `\n📊 Size: ${totalSize}` +
                `\n🚀 Speed: ${speed}` +
                `\n⏱ ETA: ${eta}\n\n` +
                `❌ Type /cancel to stop`,
              parseMode: "html",
            })
            .catch(() => {});
        }
      },
      cancelToken
    );

    if (cancelToken.cancelled) throw new Error("cancelled");

    // Find the actual downloaded file
    const possibleExtensions = [".m4a", ".webm", ".opus", ".mp3"];
    let actualFile = null;

    for (const ext of possibleExtensions) {
      const testPath = outputTemplate.replace(".%(ext)s", ext);
      if (fs.existsSync(testPath)) {
        actualFile = testPath;
        break;
      }
    }

    if (!actualFile) {
      throw new Error("Downloaded audio file not found");
    }

    tempPath = actualFile;

    // Convert to MP3 if not already
    if (!tempPath.endsWith(".mp3")) {
      console.log("🔧 Converting to MP3...");

      await statusMessage.edit({
        text:
          `🎵 <b>${videoInfo.title}</b>\n\n` +
          `🔄 Converting to MP3...\n` +
          `Please wait...`,
        parseMode: "html",
      });

      audioPath = path.join(tempDir, `${sanitizedTitle}_${timestamp}.mp3`);
      await convertToMP3(tempPath, audioPath);

      if (fs.existsSync(tempPath)) {
        fs.unlinkSync(tempPath);
      }
    } else {
      audioPath = tempPath;
    }

    if (cancelToken.cancelled) throw new Error("cancelled");

    const stats = fs.statSync(audioPath);
    const fileSizeMB = stats.size / (1024 * 1024);

    console.log(`📊 Final MP3 size: ${formatFileSize(stats.size)}`);

    if (fileSizeMB > MAX_FILE_SIZE) {
      await statusMessage.edit({
        text: `❌ File too large: ${formatFileSize(
          stats.size
        )}\n\nMax limit: ${MAX_FILE_SIZE}MB`,
      });
      await cleanupTask(userId, audioPath);
      return;
    }

    let thumbnailBuffer = null;
    if (videoInfo.thumbnail) {
      thumbnailBuffer = await downloadThumbnailToBuffer(videoInfo.thumbnail);
      if (thumbnailBuffer) {
        thumbPath = path.join(
          tempDir,
          `${sanitizedTitle}_${timestamp}_thumb.jpg`
        );
        fs.writeFileSync(thumbPath, thumbnailBuffer);
      }
    }

    if (cancelToken.cancelled) throw new Error("cancelled");

    await statusMessage.edit({
      text:
        `🎵 <b>${videoInfo.title}</b>\n\n` +
        `📤 Uploading...\n` +
        createProgressBar(0) +
        `\n📊 Size: ${formatFileSize(stats.size)}\n\n` +
        `❌ Type /cancel to stop`,
      parseMode: "html",
    });

    console.log("📤 Starting upload...");

    const uploadSettings = getOptimalUploadSettings(stats.size);
    let lastProgress = 0;
    lastUpdateTime = Date.now();

    await client.sendFile(chatId, {
      file: audioPath,
      fileSize: stats.size,
      workers: uploadSettings.workers,
      requestSize: uploadSettings.requestSize,
      forceDocument: false,
      caption: `🎵 ${videoInfo.title}\n\n👤 ${videoInfo.uploader}`,
      attributes: [
        new Api.DocumentAttributeFilename({
          fileName: `${sanitizedTitle}.mp3`,
        }),
        new Api.DocumentAttributeAudio({
          duration: videoInfo.duration,
          title: videoInfo.title,
          performer: videoInfo.uploader,
        }),
      ],
      thumb: thumbPath || undefined,
      replyTo: messageId,
      progressCallback: async (uploaded, total) => {
        if (cancelToken.cancelled) return;

        const progress = Math.min(
          Math.floor((Number(uploaded) / Number(total)) * 100),
          100
        );
        const now = Date.now();

        if (now - lastUpdateTime >= 5000 || progress - lastProgress >= 5) {
          lastUpdateTime = now;
          lastProgress = progress;

          await statusMessage
            .edit({
              text:
                `🎵 <b>${videoInfo.title}</b>\n\n` +
                `📤 Uploading...\n` +
                createProgressBar(progress) +
                `\n📊 ${formatFileSize(uploaded)} / ${formatFileSize(
                  total
                )}\n\n` +
                `❌ Type /cancel to stop`,
              parseMode: "html",
            })
            .catch(() => {});
        }
      },
    });

    if (cancelToken.cancelled) throw new Error("cancelled");

    console.log("✅ Upload complete");

    await new Promise((resolve) => setTimeout(resolve, 1000));

    try {
      await statusMessage.delete({ revoke: true });
    } catch (e) {}

    await cleanupTask(userId, audioPath, thumbPath);
    console.log("✅ Cleanup done\n");
  } catch (error) {
    if (error.message === "cancelled" || isCancelled) {
      console.log("🛑 Download cancelled by user");
      await statusMessage.edit({
        text: "🛑 <b>Download Cancelled</b>",
        parseMode: "html",
      });
      await cleanupTask(userId, audioPath, thumbPath);
      if (tempPath && fs.existsSync(tempPath)) {
        fs.unlinkSync(tempPath);
      }
      return;
    }

    console.error("❌ Error:", error.message);
    await cleanupTask(userId, audioPath, thumbPath);
    if (tempPath && fs.existsSync(tempPath)) {
      fs.unlinkSync(tempPath);
    }
    throw error;
  }
}

// ===========================
// 🚀 ULTRA FAST: Download Video
// ===========================

async function downloadVideo(
  url,
  chatId,
  messageId,
  quality,
  statusMessage,
  userId
) {
  let videoPath = null;
  let audioPath = null;
  let mergedPath = null;
  let thumbPath = null;
  let lastUpdateTime = Date.now();
  let isCancelled = false;

  const cancelToken = { cancelled: false };
  activeTasks.set(userId, {
    type: "video",
    quality,
    cancel: () => {
      cancelToken.cancelled = true;
      isCancelled = true;
    },
    statusMessage,
    filePath: null,
  });

  try {
    const videoInfo = await getVideoInfoFast(url);
    const qualityLabel = `${quality}p`;

    if (cancelToken.cancelled) throw new Error("cancelled");

    await statusMessage.edit({
      text:
        `📹 <b>${videoInfo.title}</b>\n\n` +
        `👤 Channel: ${videoInfo.uploader}\n` +
        `⏱ Duration: ${formatDuration(videoInfo.duration)}\n` +
        `🎬 Quality: ${qualityLabel}\n\n` +
        `⬇️ Downloading video...\n` +
        createProgressBar(0),
      parseMode: "html",
    });

    const sanitizedTitle = sanitizeFilename(videoInfo.title);
    const timestamp = Date.now();
    const videoFilename = `video_${timestamp}`;
    const audioFilename = `audio_${timestamp}`;

    const videoTemplate = path.join(tempDir, `${videoFilename}.%(ext)s`);
    const audioTemplate = path.join(tempDir, `${audioFilename}.%(ext)s`);
    const mergedOutput = path.join(tempDir, `merged_${timestamp}.mp4`);

    console.log(`📂 Video template: ${videoTemplate}`);
    console.log(`📂 Audio template: ${audioTemplate}`);
    console.log(`📂 Merged output: ${mergedOutput}`);

    // ✅ CRITICAL: Prefer h264 codec for Telegram compatibility
    let videoFormat, audioFormat;
    switch (quality) {
      case "360":
        videoFormat = "bestvideo[height<=360][vcodec^=avc1]/bestvideo[height<=360][ext=mp4]/bestvideo[height<=360]";
        break;
      case "480":
        videoFormat = "bestvideo[height<=480][vcodec^=avc1]/bestvideo[height<=480][ext=mp4]/bestvideo[height<=480]";
        break;
      case "720":
        videoFormat = "bestvideo[height<=720][vcodec^=avc1]/bestvideo[height<=720][ext=mp4]/bestvideo[height<=720]";
        break;
      case "1080":
        videoFormat = "bestvideo[height<=1080][vcodec^=avc1]/bestvideo[height<=1080][ext=mp4]/bestvideo[height<=1080]";
        break;
      default:
        videoFormat = "bestvideo[height<=360][vcodec^=avc1]/bestvideo[height<=360][ext=mp4]/bestvideo[height<=360]";
    }
    audioFormat = "bestaudio[ext=m4a]/bestaudio";

    console.log(`🎬 Video format: ${videoFormat}`);
    console.log(`🎵 Audio format: ${audioFormat}`);

    // Download video
    console.log("⬇️ Downloading video stream...");
    const ytdlpVideoArgs = [
      url,
      "-f", videoFormat,
      "-o", videoTemplate,
      "--no-warnings",
      "--no-playlist",
      "--newline",
      "--user-agent", "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
      "--no-part",
    ];

    await new Promise((resolve, reject) => {
      const ytdlp = spawn(getYtDlpPath(), ytdlpVideoArgs);

      let lastProgress = 0;
      let lastUpdate = Date.now();

      ytdlp.stdout.on("data", (data) => {
        if (cancelToken.cancelled) {
          ytdlp.kill("SIGTERM");
          reject(new Error("cancelled"));
          return;
        }

        const output = data.toString();
        const progressMatch = output.match(/\[download\]\s+(\d+\.?\d*)%/);
        
        if (progressMatch) {
          const progress = parseFloat(progressMatch[1]);
          const now = Date.now();
          
          if (now - lastUpdate >= 2000 || Math.abs(progress - lastProgress) >= 5) {
            lastUpdate = now;
            lastProgress = progress;

            statusMessage.edit({
              text:
                `📹 <b>${videoInfo.title}</b>\n\n` +
                `🎬 Quality: ${qualityLabel}\n` +
                `⬇️ Downloading video stream...\n` +
                createProgressBar(Math.floor(progress)),
              parseMode: "html",
            }).catch(() => {});
          }
        }
      });

      ytdlp.stderr.on("data", (data) => {
        const error = data.toString();
        if (!error.includes("WARNING")) {
          console.error("yt-dlp video:", error.trim());
        }
      });

      ytdlp.on("close", (code) => {
        if (cancelToken.cancelled) {
          reject(new Error("cancelled"));
        } else if (code !== 0) {
          reject(new Error(`Video download failed with code ${code}`));
        } else {
          console.log("✅ Video stream downloaded");
          resolve();
        }
      });

      ytdlp.on("error", (err) => {
        reject(new Error(`Failed to spawn yt-dlp: ${err.message}`));
      });
    });

    if (cancelToken.cancelled) throw new Error("cancelled");

    // Find video file
    const videoFiles = fs.readdirSync(tempDir).filter(f => 
      f.startsWith(videoFilename) && (f.endsWith('.mp4') || f.endsWith('.webm') || f.endsWith('.mkv'))
    );

    if (videoFiles.length === 0) {
      throw new Error("Video file not found");
    }

    videoPath = path.join(tempDir, videoFiles[0]);
    console.log(`✅ Video: ${videoPath} (${formatFileSize(fs.statSync(videoPath).size)})`);

    // Download audio
    console.log("⬇️ Downloading audio stream...");
    
    await statusMessage.edit({
      text:
        `📹 <b>${videoInfo.title}</b>\n\n` +
        `🎬 Quality: ${qualityLabel}\n` +
        `⬇️ Downloading audio stream...\n` +
        createProgressBar(0),
      parseMode: "html",
    });

    const ytdlpAudioArgs = [
      url,
      "-f", audioFormat,
      "-o", audioTemplate,
      "--no-warnings",
      "--no-playlist",
      "--newline",
      "--user-agent", "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
      "--no-part",
    ];

    await new Promise((resolve, reject) => {
      const ytdlp = spawn(getYtDlpPath(), ytdlpAudioArgs);

      let lastProgress = 0;
      let lastUpdate = Date.now();

      ytdlp.stdout.on("data", (data) => {
        if (cancelToken.cancelled) {
          ytdlp.kill("SIGTERM");
          reject(new Error("cancelled"));
          return;
        }

        const output = data.toString();
        const progressMatch = output.match(/\[download\]\s+(\d+\.?\d*)%/);
        
        if (progressMatch) {
          const progress = parseFloat(progressMatch[1]);
          const now = Date.now();
          
          if (now - lastUpdate >= 2000 || Math.abs(progress - lastProgress) >= 5) {
            lastUpdate = now;
            lastProgress = progress;

            statusMessage.edit({
              text:
                `📹 <b>${videoInfo.title}</b>\n\n` +
                `🎬 Quality: ${qualityLabel}\n` +
                `⬇️ Downloading audio stream...\n` +
                createProgressBar(Math.floor(progress)),
              parseMode: "html",
            }).catch(() => {});
          }
        }
      });

      ytdlp.stderr.on("data", (data) => {
        const error = data.toString();
        if (!error.includes("WARNING")) {
          console.error("yt-dlp audio:", error.trim());
        }
      });

      ytdlp.on("close", (code) => {
        if (cancelToken.cancelled) {
          reject(new Error("cancelled"));
        } else if (code !== 0) {
          reject(new Error(`Audio download failed with code ${code}`));
        } else {
          console.log("✅ Audio stream downloaded");
          resolve();
        }
      });

      ytdlp.on("error", (err) => {
        reject(new Error(`Failed to spawn yt-dlp: ${err.message}`));
      });
    });

    if (cancelToken.cancelled) throw new Error("cancelled");

    // Find audio file
    const audioFiles = fs.readdirSync(tempDir).filter(f => 
      f.startsWith(audioFilename) && (f.endsWith('.m4a') || f.endsWith('.webm') || f.endsWith('.opus'))
    );

    if (audioFiles.length === 0) {
      throw new Error("Audio file not found");
    }

    audioPath = path.join(tempDir, audioFiles[0]);
    console.log(`✅ Audio: ${audioPath} (${formatFileSize(fs.statSync(audioPath).size)})`);

    // ✅ BEST SOLUTION: Re-encode with optimized settings for Telegram
    console.log("🔧 Merging and optimizing for Telegram...");
    
    await statusMessage.edit({
      text:
        `📹 <b>${videoInfo.title}</b>\n\n` +
        `🎬 Quality: ${qualityLabel}\n` +
        `🔧 Processing video...\n` +
        `Please wait...`,
      parseMode: "html",
    });

    // ✅ CRITICAL: Use h264 baseline profile for maximum compatibility
    // CRF values optimized per quality to keep size small
    let crfValue;
    switch (quality) {
      case "360":
        crfValue = 26; // Smaller size, good quality for low res
        break;
      case "480":
        crfValue = 25;
        break;
      case "720":
        crfValue = 24;
        break;
      case "1080":
        crfValue = 23;
        break;
      default:
        crfValue = 26;
    }

    const ffmpegCommand = `"${ffmpegPath.path}" -i "${videoPath}" -i "${audioPath}" -c:v libx264 -preset faster -profile:v baseline -level 3.0 -crf ${crfValue} -pix_fmt yuv420p -c:a aac -b:a 128k -movflags +faststart -y "${mergedOutput}"`;

    console.log(`🔧 FFmpeg: ${ffmpegCommand}`);

    await execPromise(ffmpegCommand, { timeout: 300000 });

    console.log("✅ Processing complete");

    if (!fs.existsSync(mergedOutput)) {
      throw new Error("Merged file not created");
    }

    mergedPath = mergedOutput;

    // Cleanup intermediate files
    if (fs.existsSync(videoPath)) {
      fs.unlinkSync(videoPath);
      console.log("🗑️ Deleted video temp");
    }
    if (fs.existsSync(audioPath)) {
      fs.unlinkSync(audioPath);
      console.log("🗑️ Deleted audio temp");
    }

    const stats = fs.statSync(mergedPath);
    console.log(`📊 Final size: ${formatFileSize(stats.size)}`);

    if (stats.size < 500 * 1024) {
      throw new Error(`File too small (${formatFileSize(stats.size)})`);
    }

    const fileSizeMB = stats.size / (1024 * 1024);

    if (fileSizeMB > MAX_FILE_SIZE) {
      await statusMessage.edit({
        text: `❌ File too large: ${formatFileSize(stats.size)}\n\nMax: ${MAX_FILE_SIZE}MB`,
      });
      await cleanupTask(userId, mergedPath);
      return;
    }

    // Download thumbnail
    let thumbnailBuffer = null;
    if (videoInfo.thumbnail) {
      thumbnailBuffer = await downloadThumbnailToBuffer(videoInfo.thumbnail);
      if (thumbnailBuffer) {
        thumbPath = path.join(tempDir, `thumb_${timestamp}.jpg`);
        fs.writeFileSync(thumbPath, thumbnailBuffer);
      }
    }

    if (cancelToken.cancelled) throw new Error("cancelled");

    await statusMessage.edit({
      text:
        `📹 <b>${videoInfo.title}</b>\n\n` +
        `🎬 Quality: ${qualityLabel}\n` +
        `📤 Uploading...\n` +
        createProgressBar(0) +
        `\n📊 Size: ${formatFileSize(stats.size)}`,
      parseMode: "html",
    });

    console.log("📤 Uploading to Telegram...");

    const uploadSettings = getOptimalUploadSettings(stats.size);

    const dimensions = {
      360: { w: 640, h: 360 },
      480: { w: 854, h: 480 },
      720: { w: 1280, h: 720 },
      1080: { w: 1920, h: 1080 },
    };

    const { w, h } = dimensions[quality] || { w: 640, h: 360 };

    let lastProgress = 0;
    lastUpdateTime = Date.now();

    const fileSize = stats.size;

    await client.sendFile(chatId, {
      file: mergedPath,
      fileSize: fileSize,
      workers: uploadSettings.workers,
      requestSize: uploadSettings.requestSize,
      forceDocument: false,
      caption: `📹 ${videoInfo.title}\n\n👤 ${videoInfo.uploader}\n🎬 Quality: ${qualityLabel}`,
      attributes: [
        new Api.DocumentAttributeFilename({
          fileName: `${sanitizedTitle}.mp4`,
        }),
        new Api.DocumentAttributeVideo({
          duration: videoInfo.duration,
          w: w,
          h: h,
          supportsStreaming: true,
        }),
      ],
      thumb: thumbPath || undefined,
      replyTo: messageId,
      supportsStreaming: true,
      progressCallback: async (uploaded, total) => {
        if (cancelToken.cancelled) return;

        const uploadedBytes = typeof uploaded === 'bigint' ? Number(uploaded) : uploaded;
        const totalBytes = typeof total === 'bigint' ? Number(total) : (total || fileSize);

        const progress = Math.min(Math.floor((uploadedBytes / totalBytes) * 100), 100);
        const now = Date.now();

        if (now - lastUpdateTime >= 5000 || progress - lastProgress >= 5) {
          lastUpdateTime = now;
          lastProgress = progress;

          await statusMessage.edit({
            text:
              `📹 <b>${videoInfo.title}</b>\n\n` +
              `🎬 Quality: ${qualityLabel}\n` +
              `📤 Uploading...\n` +
              createProgressBar(progress) +
              `\n📊 ${formatFileSize(uploadedBytes)} / ${formatFileSize(totalBytes)}`,
            parseMode: "html",
          }).catch(() => {});
        }
      },
    });

    if (cancelToken.cancelled) throw new Error("cancelled");

    console.log("✅ Upload complete");

    await new Promise((resolve) => setTimeout(resolve, 1000));

    try {
      await statusMessage.delete({ revoke: true });
    } catch (e) {}

    await cleanupTask(userId, mergedPath, thumbPath);
    console.log("✅ Cleanup done\n");

  } catch (error) {
    if (error.message === "cancelled" || isCancelled) {
      console.log("🛑 Download cancelled");
      await statusMessage.edit({ text: "🛑 <b>Download Cancelled</b>", parseMode: "html" });
    } else {
      console.error("❌ Error:", error.message);
    }

    // Cleanup
    if (videoPath && fs.existsSync(videoPath)) fs.unlinkSync(videoPath);
    if (audioPath && fs.existsSync(audioPath)) fs.unlinkSync(audioPath);
    if (mergedPath && fs.existsSync(mergedPath)) fs.unlinkSync(mergedPath);
    if (thumbPath && fs.existsSync(thumbPath)) fs.unlinkSync(thumbPath);
    
    await cleanupTask(userId);
    
    if (error.message !== "cancelled") {
      throw error;
    }
  }
}

// ===========================
// ✅ Playlist Functions
// ===========================

async function getPlaylistVideos(
  playlistId,
  chatId,
  messageId,
  startIndex = null,
  endIndex = null
) {
  try {
    const loadingMsg = await client.sendMessage(chatId, {
      message: "🔍 Fetching playlist videos...",
      replyTo: messageId,
    });

    const yt = await Innertube.create();
    let playlist = await yt.getPlaylist(playlistId);

    const allVideos = [];
    allVideos.push(...playlist.videos);

    let lastUpdate = Date.now();
    while (playlist.has_continuation) {
      playlist = await playlist.getContinuation();
      allVideos.push(...playlist.videos);

      const now = Date.now();
      if (now - lastUpdate >= 3000) {
        lastUpdate = now;
        await loadingMsg.edit({
          text: `🔍 Fetching playlist videos...\n📊 Loaded: ${allVideos.length} videos`,
        });
      }
    }

    const videos = allVideos.map((v, index) => ({
      index: index + 1,
      title: v.title.text,
      thumbnail: v.thumbnails[0]?.url,
      url: `https://www.youtube.com/watch?v=${v.id}`,
    }));

    let filteredVideos = videos;

    if (startIndex !== null) {
      const start = Math.max(1, startIndex) - 1;
      const end =
        endIndex !== null ? Math.min(videos.length, endIndex) : videos.length;

      filteredVideos = videos.slice(start, end);

      await loadingMsg.edit({
        text:
          `📝 Playlist loaded!\n\n` +
          `📊 Total videos in playlist: ${videos.length}\n` +
          `📍 Selected range: ${startIndex} to ${endIndex || videos.length}\n` +
          `✅ Videos to download: ${filteredVideos.length}`,
      });

      await new Promise((resolve) => setTimeout(resolve, 2000));
    }

    await loadingMsg.delete({ revoke: true });

    console.log(`✅ Playlist loaded: ${filteredVideos.length} videos`);
    return filteredVideos;
  } catch (error) {
    console.error("Playlist fetch error:", error);
    throw new Error("Failed to fetch playlist");
  }
}

async function downloadMP3ForPlaylist(
  url,
  chatId,
  messageId,
  statusMessage,
  userId,
  currentVideoToken,
  playlistToken
) {
  let audioPath = null;
  let tempPath = null;
  let thumbPath = null;
  let lastUpdateTime = Date.now();

  try {
    const videoInfo = await getVideoInfoFast(url);

    if (currentVideoToken.cancelled || playlistToken.cancelled)
      throw new Error("cancelled");

    await statusMessage.edit({
      text:
        `🎵 <b>${videoInfo.title}</b>\n\n` +
        `👤 Channel: ${videoInfo.uploader}\n` +
        `⏱ Duration: ${formatDuration(videoInfo.duration)}\n\n` +
        `⬇️ Downloading audio...\n` +
        createProgressBar(0),
      parseMode: "html",
    });

    const sanitizedTitle = sanitizeFilename(videoInfo.title);
    const timestamp = Date.now();
    const outputTemplate = path.join(
      tempDir,
      `${sanitizedTitle}_${timestamp}.%(ext)s`
    );

    console.log("⬇️ Starting MP3 download...");

    const downloadedFile = await downloadWithYtDlp(
      url,
      outputTemplate,
      "bestaudio[ext=m4a]/bestaudio/best",
      (progress, totalSize, speed, eta) => {
        if (currentVideoToken.cancelled || playlistToken.cancelled) return;

        const now = Date.now();
        if (now - lastUpdateTime >= 3000) {
          lastUpdateTime = now;
          statusMessage
            .edit({
              text:
                `🎵 <b>${videoInfo.title}</b>\n\n` +
                `⬇️ Downloading audio...\n` +
                createProgressBar(Math.floor(progress)) +
                `\n📊 ${totalSize} | 🚀 ${speed}`,
              parseMode: "html",
            })
            .catch(() => {});
        }
      },
      currentVideoToken
    );

    if (currentVideoToken.cancelled || playlistToken.cancelled)
      throw new Error("cancelled");

    // Find downloaded file
    const possibleExtensions = [".m4a", ".webm", ".opus", ".mp3"];
    let actualFile = null;

    for (const ext of possibleExtensions) {
      const testPath = outputTemplate.replace(".%(ext)s", ext);
      if (fs.existsSync(testPath)) {
        actualFile = testPath;
        break;
      }
    }

    if (!actualFile) {
      throw new Error("Downloaded audio file not found");
    }

    tempPath = actualFile;

    if (!tempPath.endsWith(".mp3")) {
      audioPath = path.join(tempDir, `${sanitizedTitle}_${timestamp}.mp3`);
      await convertToMP3(tempPath, audioPath);
      if (fs.existsSync(tempPath)) {
        fs.unlinkSync(tempPath);
      }
    } else {
      audioPath = tempPath;
    }

    if (currentVideoToken.cancelled || playlistToken.cancelled)
      throw new Error("cancelled");

    const stats = fs.statSync(audioPath);
    const fileSizeMB = stats.size / (1024 * 1024);

    if (fileSizeMB > MAX_FILE_SIZE) {
      await statusMessage.edit({
        text: `❌ File too large: ${formatFileSize(
          stats.size
        )}\n\nMax limit: ${MAX_FILE_SIZE}MB`,
      });
      if (fs.existsSync(audioPath)) fs.unlinkSync(audioPath);
      throw new Error("File too large");
    }

    let thumbnailBuffer = null;
    if (videoInfo.thumbnail) {
      thumbnailBuffer = await downloadThumbnailToBuffer(videoInfo.thumbnail);
      if (thumbnailBuffer) {
        thumbPath = path.join(
          tempDir,
          `${sanitizedTitle}_${timestamp}_thumb.jpg`
        );
        fs.writeFileSync(thumbPath, thumbnailBuffer);
      }
    }

    if (currentVideoToken.cancelled || playlistToken.cancelled)
      throw new Error("cancelled");

    await statusMessage.edit({
      text:
        `🎵 <b>${videoInfo.title}</b>\n\n` +
        `📤 Uploading...\n` +
        createProgressBar(0) +
        `\n📊 Size: ${formatFileSize(stats.size)}`,
      parseMode: "html",
    });

    const uploadSettings = getOptimalUploadSettings(stats.size);

    let lastProgress = 0;
    lastUpdateTime = Date.now();

    const uploadOptions = {
      file: audioPath,
      fileSize: stats.size,
      workers: uploadSettings.workers,
      requestSize: uploadSettings.requestSize,
      forceDocument: false,
      caption: `🎵 ${videoInfo.title}\n\n👤 ${videoInfo.uploader}`,
      attributes: [
        new Api.DocumentAttributeFilename({
          fileName: `${sanitizedTitle}.mp3`,
        }),
        new Api.DocumentAttributeAudio({
          duration: videoInfo.duration,
          title: videoInfo.title,
          performer: videoInfo.uploader,
        }),
      ],
      replyTo: messageId,
      progressCallback: async (uploaded, total) => {
        if (currentVideoToken.cancelled || playlistToken.cancelled) return;

        const progress = Math.min(
          Math.floor((Number(uploaded) / Number(total)) * 100),
          100
        );
        const now = Date.now();

        if (now - lastUpdateTime >= 10000 || progress - lastProgress >= 5) {
          lastUpdateTime = now;
          lastProgress = progress;

          await statusMessage
            .edit({
              text:
                `🎵 <b>${videoInfo.title}</b>\n\n` +
                `📤 Uploading...\n` +
                createProgressBar(progress) +
                `\n📊 ${formatFileSize(uploaded)} / ${formatFileSize(total)}`,
              parseMode: "html",
            })
            .catch(() => {});
        }
      },
    };

    if (thumbPath && fs.existsSync(thumbPath)) {
      uploadOptions.thumb = thumbPath;
    }

    await client.sendFile(chatId, uploadOptions);

    if (currentVideoToken.cancelled || playlistToken.cancelled)
      throw new Error("cancelled");

    await new Promise((resolve) => setTimeout(resolve, 1500));

    try {
      await statusMessage.delete({ revoke: true });
    } catch (e) {}

    if (fs.existsSync(audioPath)) fs.unlinkSync(audioPath);
    if (thumbPath && fs.existsSync(thumbPath)) fs.unlinkSync(thumbPath);
  } catch (error) {
    if (error.message === "cancelled") {
      if (audioPath && fs.existsSync(audioPath)) fs.unlinkSync(audioPath);
      if (tempPath && fs.existsSync(tempPath)) fs.unlinkSync(tempPath);
      if (thumbPath && fs.existsSync(thumbPath)) fs.unlinkSync(thumbPath);
      throw error;
    }
    if (audioPath && fs.existsSync(audioPath)) fs.unlinkSync(audioPath);
    if (tempPath && fs.existsSync(tempPath)) fs.unlinkSync(tempPath);
    if (thumbPath && fs.existsSync(thumbPath)) fs.unlinkSync(thumbPath);
    throw error;
  }
}

// ===========================
// 🚀 FIXED: Download Video (Playlist)
// ===========================

async function downloadVideoForPlaylist(
  url,
  chatId,
  messageId,
  quality,
  statusMessage,
  userId,
  currentVideoToken,
  playlistToken
) {
  let videoPath = null;
  let thumbPath = null;
  let lastUpdateTime = Date.now();

  try {
    const videoInfo = await getVideoInfoFast(url);

    const qualityLabel = `${quality}p`;

    if (currentVideoToken.cancelled || playlistToken.cancelled)
      throw new Error("cancelled");

    await statusMessage.edit({
      text:
        `📹 <b>${videoInfo.title}</b>\n\n` +
        `👤 Channel: ${videoInfo.uploader}\n` +
        `⏱ Duration: ${formatDuration(videoInfo.duration)}\n` +
        `🎬 Quality: ${qualityLabel}\n\n` +
        `⬇️ Downloading video...\n` +
        createProgressBar(0),
      parseMode: "html",
    });

    const sanitizedTitle = sanitizeFilename(videoInfo.title);
    const timestamp = Date.now();

    // ✅ FIX: Simple filename
    const simpleFilename = `video_${timestamp}`;
    const outputTemplate = path.join(tempDir, `${simpleFilename}.%(ext)s`);

    console.log(`⬇️ Starting ${qualityLabel} video download...`);

    const formatSelector = `bestvideo[height<=${quality}][ext=mp4]+bestaudio[ext=m4a]/best[height<=${quality}][ext=mp4]/best[height<=${quality}]`;

    const downloadedFile = await downloadWithYtDlp(
      url,
      outputTemplate,
      formatSelector,
      (progress, totalSize, speed, eta) => {
        if (currentVideoToken.cancelled || playlistToken.cancelled) return;

        const now = Date.now();
        if (now - lastUpdateTime >= 3000) {
          lastUpdateTime = now;
          statusMessage
            .edit({
              text:
                `📹 <b>${videoInfo.title}</b>\n\n` +
                `🎬 Quality: ${qualityLabel}\n` +
                `⬇️ Downloading...\n` +
                createProgressBar(Math.floor(progress)) +
                `\n📊 ${totalSize} | 🚀 ${speed}`,
              parseMode: "html",
            })
            .catch(() => {});
        }
      },
      currentVideoToken
    );

    if (currentVideoToken.cancelled || playlistToken.cancelled)
      throw new Error("cancelled");

    // ✅ FIX: Better file detection
    let actualFile = null;

    if (downloadedFile && fs.existsSync(downloadedFile)) {
      actualFile = downloadedFile;
    } else {
      const files = fs.readdirSync(tempDir);
      const matchingFiles = files.filter(
        (f) =>
          f.startsWith(simpleFilename) &&
          (f.endsWith(".mp4") || f.endsWith(".mkv") || f.endsWith(".webm"))
      );

      if (matchingFiles.length > 0) {
        actualFile = path.join(tempDir, matchingFiles[0]);
      }
    }

    if (!actualFile) {
      const possibleExtensions = [".mp4", ".mkv", ".webm"];
      for (const ext of possibleExtensions) {
        const testPath = path.join(tempDir, `${simpleFilename}${ext}`);
        if (fs.existsSync(testPath)) {
          actualFile = testPath;
          break;
        }
      }
    }

    if (!actualFile) {
      throw new Error("Downloaded video file not found");
    }

    videoPath = actualFile;

    const stats = fs.statSync(videoPath);
    const fileSizeMB = stats.size / (1024 * 1024);

    if (fileSizeMB > MAX_FILE_SIZE) {
      await statusMessage.edit({
        text: `❌ File too large: ${formatFileSize(
          stats.size
        )}\n\nMax limit: ${MAX_FILE_SIZE}MB`,
      });
      if (fs.existsSync(videoPath)) fs.unlinkSync(videoPath);
      throw new Error("File too large");
    }

    let thumbnailBuffer = null;
    if (videoInfo.thumbnail) {
      thumbnailBuffer = await downloadThumbnailToBuffer(videoInfo.thumbnail);
      if (thumbnailBuffer) {
        thumbPath = path.join(tempDir, `${simpleFilename}_thumb.jpg`);
        fs.writeFileSync(thumbPath, thumbnailBuffer);
      }
    }

    if (currentVideoToken.cancelled || playlistToken.cancelled)
      throw new Error("cancelled");

    await statusMessage.edit({
      text:
        `📹 <b>${videoInfo.title}</b>\n\n` +
        `🎬 Quality: ${qualityLabel}\n` +
        `📤 Uploading...\n` +
        createProgressBar(0) +
        `\n📊 Size: ${formatFileSize(stats.size)}`,
      parseMode: "html",
    });

    const uploadSettings = getOptimalUploadSettings(stats.size);

    const dimensions = {
      360: { w: 640, h: 360 },
      480: { w: 854, h: 480 },
      720: { w: 1280, h: 720 },
      1080: { w: 1920, h: 1080 },
    };

    const { w, h } = dimensions[quality] || { w: 640, h: 360 };

    let lastProgress = 0;
    lastUpdateTime = Date.now();

    const uploadOptions = {
      file: videoPath,
      fileSize: stats.size,
      workers: uploadSettings.workers,
      requestSize: uploadSettings.requestSize,
      forceDocument: false,
      caption: `📹 ${videoInfo.title}\n\n👤 ${videoInfo.uploader}\n🎬 Quality: ${qualityLabel}`,
      attributes: [
        new Api.DocumentAttributeFilename({
          fileName: `${sanitizedTitle}.mp4`,
        }),
        new Api.DocumentAttributeVideo({
          duration: videoInfo.duration,
          w: w,
          h: h,
          supportsStreaming: true,
        }),
      ],
      replyTo: messageId,
      supportsStreaming: true,
      progressCallback: async (uploaded, total) => {
        if (currentVideoToken.cancelled || playlistToken.cancelled) return;

        const progress = Math.min(
          Math.floor((Number(uploaded) / Number(total)) * 100),
          100
        );
        const now = Date.now();

        if (now - lastUpdateTime >= 10000 || progress - lastProgress >= 5) {
          lastUpdateTime = now;
          lastProgress = progress;

          await statusMessage
            .edit({
              text:
                `📹 <b>${videoInfo.title}</b>\n\n` +
                `🎬 Quality: ${qualityLabel}\n` +
                `📤 Uploading...\n` +
                createProgressBar(progress) +
                `\n📊 ${formatFileSize(uploaded)} / ${formatFileSize(total)}`,
              parseMode: "html",
            })
            .catch(() => {});
        }
      },
    };

    if (thumbPath && fs.existsSync(thumbPath)) {
      uploadOptions.thumb = thumbPath;
    }

    await client.sendFile(chatId, uploadOptions);

    if (currentVideoToken.cancelled || playlistToken.cancelled)
      throw new Error("cancelled");

    await new Promise((resolve) => setTimeout(resolve, 1500));

    try {
      await statusMessage.delete({ revoke: true });
    } catch (e) {}

    if (fs.existsSync(videoPath)) fs.unlinkSync(videoPath);
    if (thumbPath && fs.existsSync(thumbPath)) fs.unlinkSync(thumbPath);
  } catch (error) {
    if (error.message === "cancelled") {
      if (videoPath && fs.existsSync(videoPath)) fs.unlinkSync(videoPath);
      if (thumbPath && fs.existsSync(thumbPath)) fs.unlinkSync(thumbPath);
      throw error;
    }
    if (videoPath && fs.existsSync(videoPath)) fs.unlinkSync(videoPath);
    if (thumbPath && fs.existsSync(thumbPath)) fs.unlinkSync(thumbPath);
    throw error;
  }
}

async function downloadPlaylist(
  videos,
  chatId,
  messageId,
  quality,
  userId,
  startIndex = 1
) {
  const totalVideos = videos.length;
  let successCount = 0;
  let failedCount = 0;
  let skippedCount = 0;

  const currentVideoToken = { cancelled: false };
  const playlistToken = { cancelled: false };

  activeTasks.set(userId, {
    type: "playlist",
    quality,
    currentVideoToken: currentVideoToken,
    playlistToken: playlistToken,
    cancel: () => {
      currentVideoToken.cancelled = true;
      console.log("⏭️ Skipping current video...");
    },
    cancelPlaylist: () => {
      playlistToken.cancelled = true;
      console.log("🛑 Cancelling entire playlist...");
    },
    statusMessage: null,
    filePath: null,
  });

  const statusMessage = await client.sendMessage(chatId, {
    message:
      `📝 Starting playlist download\n` +
      `📊 Total videos: ${totalVideos}\n` +
      `📍 Starting from: Video #${videos[0].index}\n\n` +
      `⏳ Processing...\n\n` +
      `Use buttons below to control:`,
    replyTo: messageId,
    buttons: createPlaylistCancelButtons(userId),
  });

  const task = activeTasks.get(userId);
  if (task) task.statusMessage = statusMessage;

  for (let i = 0; i < videos.length; i++) {
    if (playlistToken.cancelled) {
      console.log("🛑 Playlist download cancelled by user");
      try {
        await statusMessage.edit({
          text:
            `🛑 <b>Playlist Download Cancelled</b>\n\n` +
            `📊 Progress: ${i}/${totalVideos}\n` +
            `✅ Success: ${successCount}\n` +
            `⏭️ Skipped: ${skippedCount}\n` +
            `❌ Failed: ${failedCount}\n\n` +
            `Cancelled by user.`,
          parseMode: "html",
        });
      } catch (error) {
        console.error("Error updating cancel message:", error.message);
      }
      await cleanupTask(userId);
      return;
    }

    currentVideoToken.cancelled = false;

    const video = videos[i];
    const videoNumber = i + 1;
    const actualVideoNumber = video.index;

    try {
      try {
        await statusMessage.edit({
          text:
            `📝 Downloading Playlist\n\n` +
            `📊 Progress: ${videoNumber}/${totalVideos}\n` +
            `📍 Playlist position: #${actualVideoNumber}\n` +
            `✅ Success: ${successCount}\n` +
            `⏭️ Skipped: ${skippedCount}\n` +
            `❌ Failed: ${failedCount}\n\n` +
            `⬇️ Current: ${video.title.substring(0, 50)}...\n\n` +
            `Use buttons below to control:`,
          parseMode: "html",
          buttons: createPlaylistCancelButtons(userId),
        });
      } catch (error) {
        console.log("Status update error (non-critical):", error.message);
      }

      const videoStatusMsg = await client.sendMessage(chatId, {
        message: `⏳ [#${actualVideoNumber}] [${videoNumber}/${totalVideos}] Processing...`,
        replyTo: messageId,
      });

      if (i > 0) {
        const delay = 5000;
        console.log(`⏳ Waiting ${delay}ms before next download...`);
        await new Promise((resolve) => setTimeout(resolve, delay));
      }

      if (playlistToken.cancelled) break;

      try {
        if (quality === "mp3") {
          await downloadMP3ForPlaylist(
            video.url,
            chatId,
            messageId,
            videoStatusMsg,
            userId,
            currentVideoToken,
            playlistToken
          );
        } else {
          await downloadVideoForPlaylist(
            video.url,
            chatId,
            messageId,
            quality,
            videoStatusMsg,
            userId,
            currentVideoToken,
            playlistToken
          );
        }

        if (currentVideoToken.cancelled) {
          skippedCount++;
          console.log(
            `⏭️ [#${actualVideoNumber}] [${videoNumber}/${totalVideos}] Skipped: ${video.title}`
          );
          await client.sendMessage(chatId, {
            message: `⏭️ [#${actualVideoNumber}] Skipped: ${video.title.substring(
              0,
              50
            )}...`,
            replyTo: messageId,
          });
        } else {
          successCount++;
          console.log(
            `✅ [#${actualVideoNumber}] [${videoNumber}/${totalVideos}] Downloaded: ${video.title}`
          );
        }
      } catch (error) {
        if (error.message === "cancelled") {
          skippedCount++;
          console.log(
            `⏭️ [#${actualVideoNumber}] [${videoNumber}/${totalVideos}] Skipped: ${video.title}`
          );
          await client.sendMessage(chatId, {
            message: `⏭️ [#${actualVideoNumber}] Skipped: ${video.title.substring(
              0,
              50
            )}...`,
            replyTo: messageId,
          });
        } else {
          throw error;
        }
      }
    } catch (error) {
      if (playlistToken.cancelled) {
        break;
      }

      failedCount++;
      console.error(
        `❌ [#${actualVideoNumber}] [${videoNumber}/${totalVideos}] Failed: ${video.title}`,
        error.message
      );

      await client.sendMessage(chatId, {
        message: `❌ [#${actualVideoNumber}] Failed: ${video.title.substring(
          0,
          50
        )}...\n\nError: ${error.message}`,
        replyTo: messageId,
      });
    }
  }

  try {
    await statusMessage.edit({
      text:
        `✅ <b>Playlist Download Complete!</b>\n\n` +
        `📊 Total videos processed: ${totalVideos}\n` +
        `✅ Successfully downloaded: ${successCount}\n` +
        `⏭️ Skipped: ${skippedCount}\n` +
        `❌ Failed: ${failedCount}\n\n` +
        `🎉 All done!`,
      parseMode: "html",
    });
  } catch (error) {
    console.error("Error updating final message:", error.message);
  }

  await cleanupTask(userId);
  console.log(
    `\n🎉 Playlist finished: ${successCount}/${totalVideos} successful, ${skippedCount} skipped`
  );
}

// ===========================
// ✅ Quality Selector
// ===========================

async function showQualitySelector(
  url,
  chatId,
  messageId,
  isPlaylist = false,
  videos = null,
  startIndex = null,
  endIndex = null
) {
  let loadingMsg = null;

  try {
    loadingMsg = await client.sendMessage(chatId, {
      message: isPlaylist
        ? "🔍 Getting playlist information..."
        : "🔍 Getting video information...",
      replyTo: messageId,
    });

    const cacheKey = Date.now().toString(36);

    if (isPlaylist) {
      playlistCache.set(cacheKey, {
        videos: videos,
        originalMessageId: messageId,
        startIndex: startIndex,
      });

      setTimeout(() => {
        playlistCache.delete(cacheKey);
      }, 600000);

      let rangeInfo = "";
      if (startIndex !== null) {
        rangeInfo = `\n📍 Range: Video #${videos[0].index} to #${
          videos[videos.length - 1].index
        }`;
      }

      await client.sendMessage(chatId, {
        message:
          `📝 <b>Playlist Ready</b>\n\n` +
          `📊 Videos to download: ${videos.length}${rangeInfo}\n\n` +
          `<b>Select quality for all videos:</b>`,
        parseMode: "html",
        buttons: createQualityButtons(cacheKey, true),
        replyTo: messageId,
      });
    } else {
      const videoInfo = await getVideoInfoFast(url);

      urlCache.set(cacheKey, {
        ...videoInfo,
        originalMessageId: messageId,
      });

      setTimeout(() => {
        urlCache.delete(cacheKey);
      }, 600000);

      let qualitySelectorMsg = null;

      if (videoInfo.thumbnail) {
        const thumbnailBuffer = await downloadThumbnailToBuffer(
          videoInfo.thumbnail
        );

        if (thumbnailBuffer) {
          const tempThumbPath = path.join(tempDir, `${cacheKey}_temp.jpg`);
          fs.writeFileSync(tempThumbPath, thumbnailBuffer);

          qualitySelectorMsg = await client.sendFile(chatId, {
            file: tempThumbPath,
            caption:
              `📹 <b>${videoInfo.title}</b>\n\n` +
              `👤 Channel: ${videoInfo.uploader}\n` +
              `⏱ Duration: ${formatDuration(videoInfo.duration)}\n\n` +
              `<b>Select quality:</b>`,
            parseMode: "html",
            buttons: createQualityButtons(cacheKey),
            replyTo: messageId,
          });

          setTimeout(() => {
            if (fs.existsSync(tempThumbPath)) {
              fs.unlinkSync(tempThumbPath);
            }
          }, 5000);
        }
      }

      if (!qualitySelectorMsg) {
        qualitySelectorMsg = await client.sendMessage(chatId, {
          message:
            `📹 <b>${videoInfo.title}</b>\n\n` +
            `👤 Channel: ${videoInfo.uploader}\n` +
            `⏱ Duration: ${formatDuration(videoInfo.duration)}\n\n` +
            `<b>Select quality:</b>`,
          parseMode: "html",
          buttons: createQualityButtons(cacheKey),
          replyTo: messageId,
        });
      }
    }

    if (loadingMsg) {
      try {
        await new Promise((resolve) => setTimeout(resolve, 1000));
        await loadingMsg.delete({ revoke: true });
      } catch (e) {}
    }
  } catch (error) {
    console.error("❌ Error:", error.message);

    if (loadingMsg) {
      try {
        await loadingMsg.delete({ revoke: true });
      } catch (e) {}
    }

    await client.sendMessage(chatId, {
      message: `❌ Error: ${error.message}`,
      replyTo: messageId,
    });
  }
}

// ===========================
// ✅ Main Bot Logic
// ===========================

async function main() {
  console.log("🔐 Connecting to Telegram...");

  await client.start({
    botAuthToken: BOT_TOKEN,
  });

  console.log("✅ Bot connected!");
  console.log("📊 Max file size:", MAX_FILE_SIZE, "MB");
  console.log("🚀 Using direct yt-dlp binary for maximum speed");

  const sessionString = client.session.save();
  console.log("💾 Session saved");

  client.addEventHandler(async (event) => {
    try {
      const message = event.message;
      if (!message || !message.text) return;

      const chatId = message.chatId || message.peerId || message.chat?.id;
      const messageId = message.id;
      const text = message.text;
      const userId = chatId.toString();

      console.log("📩 Received:", text, "from", chatId);

      if (text === "/start") {
        await client.sendMessage(chatId, {
          message:
            `👋 <b>Welcome to YouTube Downloader Bot!</b>\n\n` +
            `📹 Send me any YouTube link (video or playlist)\n\n` +
            `<b>Available Formats:</b>\n` +
            `🎵 MP3 Audio (192kbps)\n` +
            `📹 360p Video\n` +
            `📹 480p Video\n` +
            `📹 720p Video\n` +
            `📹 1080p Video\n\n` +
            `<b>Features:</b>\n` +
            `✅ Single video download\n` +
            `✅ Full playlist download\n` +
            `✅ Playlist range support (see /help)\n` +
            `✅ Download & upload progress\n` +
            `✅ Thumbnail preview\n` +
            `✅ Cancel/Skip support\n` +
            `🚀 Ultra-fast downloads\n\n` +
            `⚠️ Max file size: ${MAX_FILE_SIZE}MB`,
          parseMode: "html",
        });
      } else if (text === "/cancel") {
        const task = activeTasks.get(userId);

        if (!task) {
          await client.sendMessage(chatId, {
            message: "ℹ️ No active download to cancel.",
            replyTo: messageId,
          });
          return;
        }

        if (task.type === "playlist") {
          await client.sendMessage(chatId, {
            message:
              "ℹ️ <b>Playlist Download Active</b>\n\n" +
              "Please use the control buttons in the playlist status message:\n" +
              "⏭️ Skip Current Video\n" +
              "🛑 Cancel Entire Playlist",
            parseMode: "html",
            replyTo: messageId,
          });
        } else {
          if (task.cancel) {
            task.cancel();
          }

          await client.sendMessage(chatId, {
            message: "🛑 <b>Cancelling...</b>",
            parseMode: "html",
            replyTo: messageId,
          });
        }
      } else if (text === "/help") {
        await client.sendMessage(chatId, {
          message:
            `📖 <b>Help</b>\n\n` +
            `<b>How to use:</b>\n` +
            `1. Send any YouTube video or playlist link\n` +
            `2. Choose your preferred quality\n` +
            `3. Watch the download progress\n` +
            `4. Receive your file!\n\n` +
            `<b>Playlist Range Support:</b>\n` +
            `📍 Start from video 36:\n` +
            `   <code>playlist_url | 36</code>\n\n` +
            `📍 Download videos 10 to 50:\n` +
            `   <code>playlist_url | 10-50</code>\n\n` +
            `<b>Commands:</b>\n` +
            `/start - Start the bot\n` +
            `/help - Show this help\n` +
            `/cancel - Cancel download\n\n` +
            `<b>Limitations:</b>\n` +
            `⚠️ Max file size: ${MAX_FILE_SIZE}MB\n` +
            `⚠️ One download at a time per user`,
          parseMode: "html",
        });
      } else if (isValidYouTubeUrl(text) || text.includes("|")) {
        console.log("📹 Processing YouTube URL...");

        const { url, startIndex, endIndex } = parsePlaylistInput(text);

        if (!isValidYouTubeUrl(url)) {
          await client.sendMessage(chatId, {
            message: "❌ Invalid YouTube URL",
            replyTo: messageId,
          });
          return;
        }

        if (isPlaylistUrl(url)) {
          const playlistId = extractPlaylistId(url);
          if (playlistId) {
            console.log("📝 Playlist detected:", playlistId);
            const videos = await getPlaylistVideos(
              playlistId,
              chatId,
              messageId,
              startIndex,
              endIndex
            );
            await showQualitySelector(
              url,
              chatId,
              messageId,
              true,
              videos,
              startIndex,
              endIndex
            );
          } else {
            await client.sendMessage(chatId, {
              message: "❌ Invalid playlist URL",
              replyTo: messageId,
            });
          }
        } else {
          await showQualitySelector(url, chatId, messageId, false);
        }
      } else if (text.length > 10 && !text.startsWith("/")) {
        await client.sendMessage(chatId, {
          message: "❌ Please send a valid YouTube URL",
          replyTo: messageId,
        });
      }
    } catch (error) {
      console.error("❌ Event handler error:", error.message);
    }
  }, new NewMessage({}));

  client.addEventHandler(async (update) => {
    try {
      if (update.className === "UpdateBotCallbackQuery") {
        const data = update.data.toString();
        const chatId = update.peer;
        const msgId = update.msgId;
        const userId = (chatId.userId || chatId).toString();

        console.log("🔘 Button clicked:", data);

        if (data.startsWith("skip_current_")) {
          const taskUserId = data.replace("skip_current_", "");

          if (taskUserId !== userId) {
            await client.invoke(
              new Api.messages.SetBotCallbackAnswer({
                queryId: update.queryId,
                message: "❌ This is not your download.",
                alert: true,
              })
            );
            return;
          }

          const task = activeTasks.get(userId);

          if (task && task.type === "playlist") {
            if (task.cancel) {
              task.cancel();
            }
            await client.invoke(
              new Api.messages.SetBotCallbackAnswer({
                queryId: update.queryId,
                message: "⏭️ Skipping current video...",
              })
            );
          } else {
            await client.invoke(
              new Api.messages.SetBotCallbackAnswer({
                queryId: update.queryId,
                message: "❌ No active playlist download.",
                alert: true,
              })
            );
          }
          return;
        }

        if (data.startsWith("cancel_playlist_")) {
          const taskUserId = data.replace("cancel_playlist_", "");

          if (taskUserId !== userId) {
            await client.invoke(
              new Api.messages.SetBotCallbackAnswer({
                queryId: update.queryId,
                message: "❌ This is not your download.",
                alert: true,
              })
            );
            return;
          }

          const task = activeTasks.get(userId);

          if (task && task.type === "playlist") {
            if (task.cancelPlaylist) {
              task.cancelPlaylist();
            }
            await client.invoke(
              new Api.messages.SetBotCallbackAnswer({
                queryId: update.queryId,
                message: "🛑 Cancelling entire playlist...",
              })
            );
          } else {
            await client.invoke(
              new Api.messages.SetBotCallbackAnswer({
                queryId: update.queryId,
                message: "❌ No active playlist download.",
                alert: true,
              })
            );
          }
          return;
        }

        const parts = data.split("_");

        let isPlaylist = false;
        let qualityType, cacheKey;

        if (parts[0] === "pl") {
          isPlaylist = true;
          qualityType = parts[2];
          cacheKey = parts[3];
        } else {
          qualityType = parts[1];
          cacheKey = parts[2];
        }

        if (isPlaylist) {
          const cachedPlaylist = playlistCache.get(cacheKey);
          if (!cachedPlaylist) {
            await client.invoke(
              new Api.messages.SetBotCallbackAnswer({
                queryId: update.queryId,
                message: "❌ Session expired. Please send the link again.",
                alert: true,
              })
            );
            return;
          }

          await client.invoke(
            new Api.messages.SetBotCallbackAnswer({
              queryId: update.queryId,
              message: "✅ Starting playlist download...",
            })
          );

          if (activeDownloads.has(userId)) {
            await client.sendMessage(chatId, {
              message: "⚠️ You already have an active download.",
            });
            return;
          }

          activeDownloads.set(userId, true);

          try {
            await client.invoke(
              new Api.messages.DeleteMessages({
                id: [msgId],
                revoke: true,
              })
            );
          } catch (e) {}

          try {
            await downloadPlaylist(
              cachedPlaylist.videos,
              chatId,
              cachedPlaylist.originalMessageId,
              qualityType,
              userId,
              cachedPlaylist.startIndex || 1
            );
          } catch (error) {
            console.error("Playlist download error:", error.message);
            if (!error.message.includes("cancelled")) {
              await client.sendMessage(chatId, {
                message: `❌ Playlist download error: ${error.message}`,
              });
            }
          } finally {
            activeDownloads.delete(userId);
            activeTasks.delete(userId);
          }
        } else {
          const cachedData = urlCache.get(cacheKey);
          if (!cachedData) {
            await client.invoke(
              new Api.messages.SetBotCallbackAnswer({
                queryId: update.queryId,
                message: "❌ Session expired. Please send the link again.",
                alert: true,
              })
            );
            return;
          }

          const url = cachedData.url;
          const originalMessageId = cachedData.originalMessageId;

          await client.invoke(
            new Api.messages.SetBotCallbackAnswer({
              queryId: update.queryId,
              message: "✅ Processing...",
            })
          );

          if (activeDownloads.has(userId)) {
            await client.sendMessage(chatId, {
              message: "⚠️ You already have an active download.",
            });
            return;
          }

          activeDownloads.set(userId, true);

          const statusMessage = await client.sendMessage(chatId, {
            message: "⏳ Initializing download...",
            replyTo: originalMessageId,
          });

          try {
            await client.invoke(
              new Api.messages.DeleteMessages({
                id: [msgId],
                revoke: true,
              })
            );
          } catch (e) {}

          try {
            if (qualityType === "mp3") {
              await downloadMP3(
                url,
                chatId,
                originalMessageId,
                statusMessage,
                userId
              );
            } else {
              await downloadVideo(
                url,
                chatId,
                originalMessageId,
                qualityType,
                statusMessage,
                userId
              );
            }
          } catch (error) {
            if (error.message === "cancelled") {
              return;
            }

            let errorMessage = "❌ Error: " + error.message;

            await statusMessage.edit({ text: errorMessage });
          } finally {
            activeDownloads.delete(userId);
            activeTasks.delete(userId);
          }
        }
      }
    } catch (error) {
      console.error("❌ Callback error:", error.message);
    }
  });

  console.log("🎬 Bot is listening for messages...");
  console.log("✅ Ready to receive YouTube links!\n");
}

main().catch((error) => {
  console.error("❌ Fatal error:", error);
  process.exit(1);
});

process.on("SIGINT", async () => {
  console.log("\n🛑 Bot stopping...");

  if (fs.existsSync(tempDir)) {
    const files = fs.readdirSync(tempDir);
    files.forEach((file) => {
      try {
        fs.unlinkSync(path.join(tempDir, file));
      } catch (e) {}
    });
  }

  await client.disconnect();
  process.exit(0);
});

process.on("unhandledRejection", (error) => {
  console.error("❌ Unhandled rejection:", error.message);
});


app.get("/", (req, res) => {
  res.send(`
    <h1>✅ YouTube Downloader Bot Running</h1>
    <p>📊 Active Downloads: ${activeDownloads.size}</p>
    <p>🔴 Active Tasks: ${activeTasks.size}</p>
    <p>💾 Cached URLs: ${urlCache.size}</p>
    <p>📝 Cached Playlists: ${playlistCache.size}</p>
    <p>🚀 Engine: yt-dlp (Direct Binary)</p>
  `);
});

app.listen(PORT, () => {
  console.log(`✅ Express server running on port ${PORT}`);
});
