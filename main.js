//import MapListSchema from "./mapData_pb.js";
import protobuf from 'protobufjs';
import fs from "fs";
import zlib from "zlib";
import * as stream from "node:stream";

const delay = ms => new Promise(res => setTimeout(res, ms));

const BeatSaverAPI = "https://api.beatsaver.com/maps/latest";
const BeatSaverSocketURL = "wss://ws.beatsaver.com/maps";

let cacheObject = {};

function doesMapUseMod(mapData, modName) {
    for(const diff of mapData.diffs) {
        if(modName in diff) {
            if(diff[modName] === true) {
                return true;
            }
        }
    }
    
    return false;
}

let mapListType;
let difficultyType;
protobuf.load("./mapData.proto", async function(err, root) {
    if(err != null) {
        throw Error(err);
    }

    mapListType = root.lookupType("CachedBeatSaverData.MapList");
    difficultyType = root.lookupType("CachedBeatSaverData.Difficulty");

    await initCache();
    startBeatSaverSocket();
});

async function initCache() {
    let currentDateString = new Date().toISOString();
    let keepGoing = true;
    let amount = 0;
    
    while(keepGoing) {
        let params = {
            automapper: false,
            before: currentDateString,
            pageSize: 10
        }
        let searchParams = new URLSearchParams(params);

        const URL = `${BeatSaverAPI}?${searchParams}`;

        const response = await fetch(URL);
        if(response.status !== 200) {
            console.log("Status not 200, waiting");
            await delay(3000);
            continue;
        }
        
        const data = await response.json();
        let lastMap = {};

        for(const mapData of data.docs) {
            amount++;
            
            updateCacheData(mapData);
            lastMap = mapData;
        }
        
        console.log(`[Scraper] Cached ${amount} maps (currently at: ${lastMap.id}) ...`);
        
        if(!data.docs.length) {
            console.log("[Scraper] No maps left!");
            keepGoing = false;
        } else {
            currentDateString = lastMap.uploaded;
            await delay(100);
            keepGoing = false;
        }
    }
    
    await saveProtobufCache();
}

async function saveProtobufCache() {
    let final = {mapMetadata: cacheObject};
    
    let pbErr = mapListType.verify(final);
    if(pbErr) {
        console.error(pbErr);
        return;
    }
    
    const message = mapListType.create(final);
    const encoded = mapListType.encode(message).finish();
    
    zlib.gzip(encoded, (err, buffer) => {
        if(err) { 
            console.error(err);
            return;
        }
        
        fs.writeFile("./cached.proto.gz", buffer, err => {
            if(err) {
                console.error(err);
            }
        });
    });
} 

function updateCacheData(mapData) {
    let out = {
        key: parseInt(mapData.id, 16),
        hash: mapData.versions[0].hash,
        duration: mapData.metadata.duration,
        uploaded: Math.round(new Date(mapData.lastPublishedAt).getTime() / 1000),
        lastUpdated: Math.round(new Date(mapData.updatedAt).getTime() / 1000),
        mods: (doesMapUseMod(mapData.versions[0], "cinema") ? 1 : 0) +
            (doesMapUseMod(mapData.versions[0], "me") ? 2 : 0) +
            (doesMapUseMod(mapData.versions[0], "chroma") ? 4 : 0) +
            (doesMapUseMod(mapData.versions[0], "ne") ? 8 : 0) +
            (doesMapUseMod(mapData.versions[0], "vivify") ? 16 : 0),
        votes: {
            up: mapData.stats.upvotes,
            down: mapData.stats.downvotes
        },
        difficulties: []
    };

    if("curator" in mapData) { out.curatorName = mapData.curator.name; }
    if(mapData.metadata.songName !== "") { out.songName = mapData.metadata.songName; }
    if(mapData.metadata.songSubName !== "") { out.songSubName = mapData.metadata.songSubName; }
    if(mapData.metadata.songAuthorName !== "") { out.songAuthorName = mapData.metadata.songAuthorName; }
    if(mapData.metadata.levelAuthorName !== "") { out.levelAuthorName = mapData.metadata.levelAuthorName; }

    for(const diff of mapData.versions[0].diffs) {
        let diffObj = {
            njs: diff.njs,
            notes: diff.notes,
            characteristicName: diff.characteristic,
            difficultyName: diff.difficulty,
            mods: (diff.cinema ? 1 : 0) +
                (diff.me ? 2 : 0) +
                (diff.chroma ? 4 : 0) +
                (diff.ne ? 8 : 0) +
                (diff.vivify ? 16 : 0),
            environmentName: diff.environment.replaceAll("Environment", ""),
            ranked: {
                ScoreSaber: {
                    isRanked: "stars" in diff,
                    stars: "stars" in diff ? diff.stars : 0
                },
                BeatLeader: {
                    isRanked: "blStars" in diff,
                    stars: "blStars" in diff ? diff.blStars : 0
                }
            }
        };
        
        let pbErr = difficultyType.verify(diffObj);
        if(pbErr) {
            console.error(pbErr);
            continue;
        }
        
        out.difficulties.push(diffObj);
    }
    
    cacheObject[mapData.id] = out;
}
function removeCacheData(id) {
    delete cacheObject[id];
}

let socket;
let beatSaverSocketTimeout;
function startBeatSaverSocket() {
    clearTimeout(beatSaverSocketTimeout);
    console.log("[Socket] Establishing socket connection to BeatSaver...");
    
    socket = new WebSocket(BeatSaverSocketURL);

    beatSaverSocketTimeout = setTimeout(() => {
        socket.removeEventListener("open");
        socket.removeEventListener("close");
        socket.removeEventListener("message");
        
        console.warn("[Socket] BeatSaver socket connection hit a timeout after 15 seconds, trying again...");
        startBeatSaverSocket();
    }, 15000);
    
    socket.addEventListener("open", event => {
        console.log("[Socket] BeatSaver socket connection established");
        clearTimeout(beatSaverSocketTimeout);
    });
    socket.addEventListener("close", event => {
        console.warn("[Socket] BeatSaver socket connection closed, reconnecting in 15 seconds...");
        beatSaverSocketTimeout = setTimeout(startBeatSaverSocket, 15000);
    });
    
    socket.addEventListener("message", async event => {
        const receivedData = JSON.parse(event.data);
        
        switch(receivedData.type) {
            case "MAP_UPDATE":
                console.log(`[Socket] Updating key ${receivedData.msg.id}`);
                updateCacheData(receivedData.msg);
                try {
                    await saveProtobufCache();
                } catch (e) {
                    console.error(e);
                }
                break;
            case "MAP_DELETE":
                console.log(`[Socket] Deleting key ${receivedData.msg}`);
                removeCacheData(receivedData.msg);
                try {
                    await saveProtobufCache();
                } catch (e) {
                    console.error(e);
                }
                break;
                
            default:
                console.warn(`[Socket] Unhandled event type: ${receivedData.type}`);
                break;
        }
    });
}