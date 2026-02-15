import express from 'express';
import { Readable } from 'stream';
import cors from 'cors';
import dotenv from 'dotenv';
import { createClient } from '@supabase/supabase-js';
import { exec } from 'child_process';
import fs from 'fs';
import path from 'path';
import { promisify } from 'util';

dotenv.config();

const app = express();
const PORT = process.env.PORT || 4000;

app.use(cors());
app.use(express.json());

const execAsync = promisify(exec);

// Initialize Supabase client
const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!supabaseUrl || !supabaseKey) {
    console.error("Missing Supabase credentials in environment variables.");
    process.exit(1);
}

const supabase = createClient(supabaseUrl, supabaseKey);

// Ensure temp directory exists
const tempDir = path.join(__dirname, 'temp');
if (!fs.existsSync(tempDir)) {
    fs.mkdirSync(tempDir);
}

// Health check
app.get('/', (req, res) => {
    res.status(200).send("FFmpeg worker alive");
});

app.post('/clip', async (req, res) => {
    const { inputUrl, startTime, endTime, fileName } = req.body;

    if (!inputUrl || startTime === undefined || endTime === undefined || !fileName) {
        return res.status(400).json({ error: "Missing required parameters: inputUrl, startTime, endTime, fileName" });
    }

    const tempInput = path.join(tempDir, `input_${Date.now()}.mp4`);
    const tempOutput = path.join(tempDir, `output_${Date.now()}.mp4`);

    try {
        console.log(`[worker] Processing clip: ${fileName} (${startTime}s - ${endTime}s)`);

        // 1. Download video (Streaming)
        // 1. Download video (Streaming)
        console.log(`[worker] streaming download enabled`);
        const response = await fetch(inputUrl);
        if (!response.ok) throw new Error(`Failed to fetch video`);
        if (!response.body) throw new Error("No response body");

        const fileStream = fs.createWriteStream(tempInput);
        await new Promise((resolve, reject) => {
            // @ts-ignore: specific to Node 18+ native fetch
            Readable.fromWeb(response.body as any).pipe(fileStream);
            fileStream.on("finish", resolve);
            fileStream.on("error", reject);
        });
        console.log(`[worker] Saved to ${tempInput}`);

        // 2. Run FFmpeg
        // -ss (start) -to (end) -i (input) 
        // -vf ... (scale to 9:16 vertical 1080x1920)
        // -c:v libx264 -c:a aac -preset ultrafast -crf 28 -threads 1 (LOW MEMORY)

        // Calculate 9:16 aspect ratio scaling and padding
        const filterComplex = "scale=1080:1920:force_original_aspect_ratio=decrease,pad=1080:1920:(ow-iw)/2:(oh-ih)/2";

        const command = `ffmpeg -ss ${startTime} -to ${endTime} -i "${tempInput}" -vf "${filterComplex}" -c:v libx264 -c:a aac -preset ultrafast -crf 30 -threads 1 -y "${tempOutput}"`;

        console.log(`[worker] ffmpeg started`);
        console.log(`[worker] Running: ${command}`);
        await execAsync(command);
        console.log(`[worker] FFmpeg execution complete`);

        // 3. Upload to Supabase (Streaming)
        // 3. Upload to Supabase (Streaming)
        console.log(`[worker] Uploading to processed-videos...`);

        // Check local file size
        const stats = fs.statSync(tempOutput);
        console.log(`[worker] Output file size: ${stats.size} bytes`);

        const fileContent = fs.createReadStream(tempOutput);

        const { data, error } = await supabase.storage
            .from('processed-videos')
            .upload(fileName, fileContent, {
                contentType: 'video/mp4',
                upsert: true,
                duplex: 'half' // Required for node streaming uploads in some client versions
            });

        if (error) {
            console.error("[worker] Upload error:", error);
            throw error;
        }
        console.log("[worker] upload complete");

        // 4. Get Public URL
        const { data: publicUrlData } = supabase.storage
            .from('processed-videos')
            .getPublicUrl(fileName);

        const clippedUrl = publicUrlData.publicUrl;
        console.log(`[worker] Success! Clipped URL: ${clippedUrl}`);

        // Cleanup
        if (fs.existsSync(tempInput)) fs.unlinkSync(tempInput);
        if (fs.existsSync(tempOutput)) fs.unlinkSync(tempOutput);

        return res.json({ clippedUrl });

    } catch (error: any) {
        console.error("[worker] Error processing clip:", error);

        // Cleanup on error
        if (fs.existsSync(tempInput)) fs.unlinkSync(tempInput);
        if (fs.existsSync(tempOutput)) fs.unlinkSync(tempOutput);

        return res.status(500).json({ error: error.message, stderr: error.stderr });
    }
});

app.post('/extract-audio', async (req, res) => {
    const { inputUrl, fileName } = req.body;

    if (!inputUrl) {
        return res.status(400).json({ error: "Missing required parameter: inputUrl" });
    }

    const tempInput = path.join(tempDir, `audio_input_${Date.now()}.mp4`);
    const tempOutput = path.join(tempDir, `audio_output_${Date.now()}.wav`);
    // Use provided fileName (sanitized) or generate unique one
    const storageFileName = fileName ? `${fileName}_audio.wav` : `audio_${Date.now()}.wav`;

    try {
        console.log(`[worker] Extracting audio from: ${inputUrl}`);

        // 1. Download video (Streaming)
        // 1. Download video (Streaming)
        console.log(`[worker] streaming download enabled`);
        const response = await fetch(inputUrl);
        if (!response.ok) throw new Error(`Failed to fetch video`);
        if (!response.body) throw new Error("No response body");

        const fileStream = fs.createWriteStream(tempInput);
        await new Promise((resolve, reject) => {
            // @ts-ignore: specific to Node 18+ native fetch
            Readable.fromWeb(response.body as any).pipe(fileStream);
            fileStream.on("finish", resolve);
            fileStream.on("error", reject);
        });

        // 2. Run FFmpeg (extract audio: pcm_s16le, 16kHz, mono)
        // Command: ffmpeg -i input.mp4 -ac 1 -ar 16000 -vn output.wav
        // Added -threads 1 for low memory
        const command = `ffmpeg -i "${tempInput}" -ac 1 -ar 16000 -vn -threads 1 -y "${tempOutput}"`;

        console.log(`[worker] ffmpeg started`);
        console.log(`[worker] Running: ${command}`);
        await execAsync(command);
        console.log(`[worker] Audio extraction complete`);

        // 3. Check file size
        const stats = fs.statSync(tempOutput);
        console.log(`[worker] Audio file size: ${stats.size} bytes`);

        if (stats.size < 1024) { // Warning if < 1KB
            console.warn("[worker] Extracted audio is very small!");
        }

        // 4. Upload to Supabase (Streaming)
        console.log(`[worker] Uploading to processed-videos as ${storageFileName}...`);
        const fileContent = fs.createReadStream(tempOutput);

        const { data, error } = await supabase.storage
            .from('processed-videos')
            .upload(storageFileName, fileContent, {
                contentType: 'audio/wav',
                upsert: true,
                duplex: 'half'
            });

        if (error) {
            console.error("[worker] Upload error:", error);
            throw error;
        }
        console.log("[worker] upload complete");

        // 5. Get Public URL
        const { data: publicUrlData } = supabase.storage
            .from('processed-videos')
            .getPublicUrl(storageFileName);

        const audioUrl = publicUrlData.publicUrl;
        console.log(`[worker] Success! Audio URL: ${audioUrl}`);

        // Cleanup
        if (fs.existsSync(tempInput)) fs.unlinkSync(tempInput);
        if (fs.existsSync(tempOutput)) fs.unlinkSync(tempOutput);

        return res.json({ audioUrl });

    } catch (error: any) {
        console.error("[worker] Error extracting audio:", error);

        // Cleanup on error
        if (fs.existsSync(tempInput)) fs.unlinkSync(tempInput);
        if (fs.existsSync(tempOutput)) fs.unlinkSync(tempOutput);

        return res.status(500).json({ error: error.message, stderr: error.stderr });
    }
});

app.listen(PORT, () => {
    console.log("FFmpeg worker running on port", PORT);
    console.log("[worker] running in low-memory streaming mode");
});
