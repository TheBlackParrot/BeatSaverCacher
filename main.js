import MapListSchema from "./mapData_pb.js";
import fs from "fs";

const delay = ms => new Promise(res => setTimeout(res, ms));

const BeatSaverAPI = "https://api.beatsaver.com/maps/latest";
const BeatSaverSocketURL = "wss://ws.beatsaver.com/maps";

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

let mapList = new MapListSchema.MapList();
let mapListMap = mapList.getMapmetadataMap();

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
    
    //fs.writeFileSync("./test.json", JSON.stringify(MapListSchema.MapList.deserializeBinary(mapList.serializeBinary()).toObject(), null, "\t"));
}
await initCache();

// https://stackoverflow.com/a/79082701
async function compressUint8Array(uint8Array) {
    return new Uint8Array(await new Response(new Blob([uint8Array]).stream().pipeThrough(new CompressionStream('gzip'))).arrayBuffer());
}
async function saveProtobufCache() {
    let saveData = await compressUint8Array(mapList.serializeBinary());
    await fs.writeFile("./cached.proto.gz", saveData, err => {
        if (err) {
            console.error(err);
        }
    });
    
    try {
        fs.writeFileSync("./test.json", JSON.stringify(MapListSchema.MapList.deserializeBinary(mapList.serializeBinary()).toObject(), null, "\t"));
    } catch(err) {
        console.error(err.message);
    }
} 

function updateCacheData(mapData) {
    let entry = mapListMap.get(mapData.id);
    if(entry == null) {
        entry = new MapListSchema.MapMetadata();
    }

    entry.setKey(parseInt(mapData.id, 16));
    entry.setHash(mapData.versions[0].hash);
    entry.setDuration(mapData.metadata.duration);
    entry.setUploaded(Math.round(new Date(mapData.lastPublishedAt).getTime() / 1000));
    entry.setLastupdated(Math.round(new Date(mapData.updatedAt).getTime() / 1000));
    entry.setMods((doesMapUseMod(mapData.versions[0], "cinema") ? MapListSchema.MapMods.CINEMA : 0) +
        (doesMapUseMod(mapData.versions[0], "me") ? MapListSchema.MapMods.MAPPINGEXTENSIONS : 0) +
        (doesMapUseMod(mapData.versions[0], "chroma") ? MapListSchema.MapMods.CHROMA : 0) +
        (doesMapUseMod(mapData.versions[0], "ne") ? MapListSchema.MapMods.NOODLEEXTENSIONS : 0) +
        (doesMapUseMod(mapData.versions[0], "vivify") ? MapListSchema.MapMods.VIVIFY : 0));

    let votes = entry.getVotes();
    if(votes == null) {
        votes = new MapListSchema.Votes();
        entry.setVotes(votes);
    }
    votes.setUp(mapData.stats.upvotes);
    votes.setDown(mapData.stats.downvotes);

    if("curator" in mapData) { entry.setCuratorname(mapData.curator.name); }
    if(mapData.metadata.songName !== "") { entry.setSongname(mapData.metadata.songName); }
    if(mapData.metadata.songSubName !== "") { entry.setSongsubname(mapData.metadata.songSubName); }
    if(mapData.metadata.songAuthorName !== "") { entry.setSongauthorname(mapData.metadata.songAuthorName); }
    if(mapData.metadata.levelAuthorName !== "") { entry.setLevelauthorname(mapData.metadata.levelAuthorName); }

    entry.clearDifficultiesList();
    for(const diff of mapData.versions[0].diffs) {
        let diffEntry = new MapListSchema.Difficulty();
        diffEntry.setNjs(diff.njs);
        diffEntry.setNotes(diff.notes);
        diffEntry.setCharacteristicname(diff.characteristic);
        diffEntry.setDifficultyname(diff.difficulty);
        diffEntry.setMods((diff.cinema ? MapListSchema.MapMods.CINEMA : 0) +
            (diff.me ? MapListSchema.MapMods.MAPPINGEXTENSIONS : 0) +
            (diff.chroma ? MapListSchema.MapMods.CHROMA : 0) +
            (diff.ne ? MapListSchema.MapMods.NOODLEEXTENSIONS : 0) +
            (diff.vivify ? MapListSchema.MapMods.VIVIFY : 0));
        diffEntry.setEnvironmentname(diff.environment.replaceAll("Environment", ""));
        
        let rankedEntry = new MapListSchema.Ranked();
        
        let ssDiffRankedData = new MapListSchema.RankedValue();
        ssDiffRankedData.setIsranked("stars" in diff);
        ssDiffRankedData.setStars("stars" in diff ? diff.stars : 0);
        rankedEntry.setScoresaber(ssDiffRankedData);

        let blDiffRankedData = new MapListSchema.RankedValue();
        blDiffRankedData.setIsranked("blStars" in diff);
        blDiffRankedData.setStars("blStars" in diff ? diff.blStars : 0);
        rankedEntry.setBeatleader(blDiffRankedData);

        diffEntry.setRanked(rankedEntry);

        entry.addDifficulties(diffEntry);
    }
    
    mapListMap.set(mapData.id, entry);
}
function removeCacheData(id) {
    mapListMap.del(id);
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
startBeatSaverSocket();