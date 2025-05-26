import protobuf from 'protobufjs';
import fs from "fs";
import zlib from "zlib";
import settings from "./settings.json" with { type: "json" };

const delay = ms => new Promise(res => setTimeout(res, ms));

const BeatSaverAPI = "https://api.beatsaver.com/maps";
const BeatSaverMapSocketURL = "wss://ws.beatsaver.com/maps";
const BeatSaverVotingSocketURL = "wss://ws.beatsaver.com/votes";

/* the votes socket endpoint appears to be undocumented, this is the only event i'm seeing:
{
  "type": "VOTE",
  "msg": {
    "hash": "49222e7d40686bcfa9e4097738f803ca0d1e7019",
    "mapId": "4659f",
    "upvotes": 124,
    "downvotes": 1,
    "score": 0.9561
  }
}
 */

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
    startBeatSaverMapSocket();
    startBeatSaverVoteSocket();
});

async function fetchMapData(id) {
    const URL = `${BeatSaverAPI}/id/${id}`;

    const response = await fetch(URL);
    if(response.status !== 200) {
        console.warn(`Status not 200, not caching ${id}`);
        return;
    }
    
    updateCacheData(await response.json());
    console.log(`[Scraper] Cached id ${id}`);
    await saveProtobufCache();
}

async function initCache() {
    let currentDateString = new Date().toISOString();
    let keepGoing = true;
    let amount = 0;
    
    while(keepGoing) {
        let params = {
            automapper: false,
            before: currentDateString,
            pageSize: 100
        }
        let searchParams = new URLSearchParams(params);

        const URL = `${BeatSaverAPI}/latest?${searchParams}`;

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
        
        fs.writeFile(settings.cacheFile, buffer, err => {
            if(err) {
                console.error(err);
            }
        });
    });
} 

function updateCacheData(mapData) {
    if(!("lastPublishedAt" in mapData)) {
        console.log(`${mapData.id} hasn't been published before, ignoring`);
        removeCacheData(mapData.id);
        return;
    }
    if(mapData.versions[0].state !== "Published") {
        console.log(`${mapData.id} is not published, ignoring`);
        removeCacheData(mapData.id);
        return;
    }
    if(mapData.declaredAi !== "None") {
        console.log(`${mapData.id} has been declared as AI-generated, ignoring`);
        removeCacheData(mapData.id);
        return;
    }
    if(mapData.automapper) {
        console.log(`${mapData.id} is automapped, ignoring`);
        removeCacheData(mapData.id);
        return;
    }
    
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
                    isRanked: ("stars" in diff),
                    stars: ("stars" in diff ? (isNaN(diff.stars) ? 0 : (diff.stars ?? 0)) : 0)
                },
                BeatLeader: {
                    isRanked: ("blStars" in diff),
                    stars: ("blStars" in diff ? (isNaN(diff.blStars) ? 0 : (diff.blStars ?? 0)) : 0)
                }
            }
        };
        
        let pbErr = difficultyType.verify(diffObj);
        if(pbErr) {
            console.error(pbErr);
            console.log(diffObj);
            continue;
        }
        
        out.difficulties.push(diffObj);
    }
    
    cacheObject[mapData.id] = out;
}
function removeCacheData(id) {
    if(id in cacheObject) {
        delete cacheObject[id];
    }
}

async function updateVotingData(voteData) {
    const id = voteData.mapId;
    if(!(id in cacheObject)) {
        console.log(`[Socket] ${id} wanted a voting update, but it's not cached, fetching...`);
        await fetchMapData(id);
        return;
    }

    cacheObject[id].votes.up = voteData.upvotes;
    cacheObject[id].votes.down = voteData.downvotes;
}

let mapSocket;
let mapSocketTimeout;
function startBeatSaverMapSocket() {
    clearTimeout(mapSocketTimeout);
    console.log("[Socket] Establishing map data socket connection to BeatSaver...");
    
    mapSocket = new WebSocket(BeatSaverMapSocketURL);

    mapSocketTimeout = setTimeout(() => {
        mapSocket.removeEventListener("open");
        mapSocket.removeEventListener("close");
        mapSocket.removeEventListener("message");
        
        console.warn("[Socket] BeatSaver map data socket connection hit a timeout after 15 seconds, trying again...");
        startBeatSaverMapSocket();
    }, 15000);
    
    mapSocket.addEventListener("open", () => {
        console.log("[Socket] BeatSaver map data socket connection established");
        clearTimeout(mapSocketTimeout);
    });
    mapSocket.addEventListener("close", () => {
        console.warn("[Socket] BeatSaver map data socket connection closed, reconnecting in 15 seconds...");
        mapSocketTimeout = setTimeout(startBeatSaverMapSocket, 15000);
    });
    
    mapSocket.addEventListener("message", async event => {
        const receivedData = JSON.parse(event.data);
        
        switch(receivedData.type) {
            case "MAP_UPDATE":
                console.log(`[Socket] Updating map data for key ${receivedData.msg.id}`);
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
                console.warn(`[Socket] Unhandled map data event type: ${receivedData.type}`);
                break;
        }
    });
}

let voteSocket;
let voteSocketTimeout;
function startBeatSaverVoteSocket() {
    clearTimeout(voteSocketTimeout);
    console.log("[Socket] Establishing voting data socket connection to BeatSaver...");

    voteSocket = new WebSocket(BeatSaverVotingSocketURL);

    voteSocketTimeout = setTimeout(() => {
        voteSocket.removeEventListener("open");
        voteSocket.removeEventListener("close");
        voteSocket.removeEventListener("message");

        console.warn("[Socket] BeatSaver voting data socket connection hit a timeout after 15 seconds, trying again...");
        startBeatSaverVoteSocket();
    }, 15000);

    voteSocket.addEventListener("open", () => {
        console.log("[Socket] BeatSaver voting data socket connection established");
        clearTimeout(voteSocketTimeout);
    });
    voteSocket.addEventListener("close", () => {
        console.warn("[Socket] BeatSaver voting data socket connection closed, reconnecting in 15 seconds...");
        voteSocketTimeout = setTimeout(startBeatSaverVoteSocket, 15000);
    });

    voteSocket.addEventListener("message", async event => {
        const receivedData = JSON.parse(event.data);

        switch(receivedData.type) {
            case "VOTE":
                console.log(`[Socket] Updating voting data for key ${receivedData.msg.mapId}`);
                await updateVotingData(receivedData.msg);
                break;

            default:
                console.warn(`[Socket] Unhandled voting data event type: ${receivedData.type}`);
                break;
        }
    });
}