const MapListSchema = require("./mapData_pb.js");
const fs = require("fs");

const delay = ms => new Promise(res => setTimeout(res, ms));

const BeatSaverAPI = "https://api.beatsaver.com/maps/latest";

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

async function run() {
    let currentDateString = new Date().toISOString();
    let keepGoing = true;
    let amount = 0;

    let mapList = new MapListSchema.MapList();
    
    while(keepGoing) {
        let params = {
            automapper: false,
            before: currentDateString,
            pageSize: 100
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
            
            let entry = new MapListSchema.MapMetadata();
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
            
            let votes = new MapListSchema.Votes();
            votes.setUp(mapData.stats.upvotes);
            votes.setDown(mapData.stats.downvotes);
            entry.setVotes(votes);

            if("curator" in mapData) { entry.setCuratorname(mapData.curator.name); }
            if(mapData.metadata.songName !== "") { entry.setSongname(mapData.metadata.songName); }
            if(mapData.metadata.songSubName !== "") { entry.setSongsubname(mapData.metadata.songSubName); }
            if(mapData.metadata.songAuthorName !== "") { entry.setSongauthorname(mapData.metadata.songAuthorName); }
            if(mapData.metadata.levelAuthorName !== "") { entry.setLevelauthorname(mapData.metadata.levelAuthorName); }
            
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
                
                entry.addDifficulties(diffEntry);
            }
            
            mapList.addMapmetadata(entry);
            lastMap = mapData;
        }
        
        console.log(`Cached ${amount} maps (currently at: ${lastMap.id}) ...`);
        
        if(!data.docs.length) {
            console.log("No maps left!");
            keepGoing = false;
        } else {
            currentDateString = lastMap.uploaded;
            await delay(100);
        }
    }
    
    fs.writeFileSync("./cached.proto", mapList.serializeBinary());
    
    //fs.writeFileSync("./test.json", JSON.stringify(MapListSchema.MapList.deserializeBinary(mapList.serializeBinary()).toObject(), null, "\t"));
}
run();