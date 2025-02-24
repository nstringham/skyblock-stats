const helper = require('./helper');
const lib = require('./lib');
const cors = require('cors');
const constants = require('./constants');
const credentials = require('../credentials.json');

const Redis = require("ioredis");
const redisClient = new Redis();

function handleError(e, res){
    console.error(e);

    res.status(500).json({
        error: e.toString()
    });
}

async function getUserObject(usernameOrUuid, db, cacheOnly = true){
    let isUuid = false;
    let uuidTrimmed = usernameOrUuid;

    if(usernameOrUuid.length >= 32){
        isUuid = true;
        uuidTrimmed = usernameOrUuid.substring(0, 32);
    }

    const userObject = await helper.resolveUsernameOrUuid(uuidTrimmed, db, true);

    if(isUuid && usernameOrUuid.endsWith('i')){
        userObject.display_name += ' ♲';
        userObject.uuid = uuidTrimmed;
    }

    return userObject;
}

module.exports = (app, db) => {
    const productInfo = {};
    const leaderboards = [];

    const initFunction = async () => {
        const bazaarProducts = await db
        .collection('bazaar')
        .find()
        .toArray();

        const itemInfo = await db
        .collection('items')
        .find({ id: { $in: bazaarProducts.map(a => a.productId) } })
        .toArray();

        for(const product of bazaarProducts){
            const info = itemInfo.filter(a => a.id == product.productId);

            if(info.length > 0)
                productInfo[product.productId] = info[0];
        }

        leaderboards.length = 0;

        const keys = await redisClient.keys('lb_*');

        for(const key of keys){
            const lb = constants.leaderboard(key);

            if(lb.mappedBy == 'uuid' && !lb.key.startsWith('collection_enchanted'))
                leaderboards.push(lb);
        }

        return;
    }

    const init = initFunction();

    app.use('/api/v2/*', async (req, res, next) => {
        req.cacheOnly = true;

        if(req.query.key){
            const doc = await db
            .collection('apiKeys')
            .findOne({ key: req.query.key });

            if(doc != null)
                req.cacheOnly = false;
        }

        next();
    });

    app.all('/api/v2/leaderboards/:playerName', cors(), async (req, res) => {
        let userObject;

        try{
            userObject = await getUserObject(req.params.playerName, db, true);

            if(userObject.uuid == userObject.display_name)
                throw "User not found.";
        }catch(e){
            res.status(404).json({ error: e.toString() });
            return;
        }

        const modeName = req.query.mode != null ? `${req.query.mode}_` : '';

        const { uuid } = userObject;

        if(req.cacheOnly == false)
            await lib.getProfile(db, uuid, null, { cacheOnly: false, waitForLb: true });
        
        const getRanks = redisClient.pipeline();

        for(const lb of leaderboards){
            if(lb.sortedBy > 0){
                getRanks.zrank(`${modeName}lb_${lb.key}`, uuid); 
                getRanks.zrank(`${modeName}lb_${lb.key}`, `${uuid}i`);
            }else{
                getRanks.zrevrank(`${modeName}lb_${lb.key}`, uuid);
                getRanks.zrevrank(`${modeName}lb_${lb.key}`, `${uuid}i`);
            }
        }

        const output = { 
            self: {
                uuid,
                username: userObject.display_name
            },
            positions: []
        };

        const positions = [];

        const ranks = await getRanks.exec();

        for(let i = 0; i < ranks.length; i += 2){
            let leaderboard = { ... leaderboards[Math.floor(i / 2)] };

            let resultRegular = ranks[i];
            let resultIronman = ranks[i + 1];

            if(resultRegular != null && (resultRegular[0] != null || resultRegular[1] == null || resultRegular[1] > credentials.lbCap))
                resultRegular = null;

            if(resultIronman != null && (resultIronman[0] != null || resultIronman[1] == null || resultIronman[1] > credentials.lbCap))
                resultIronman = null;

            if(resultRegular == null && resultIronman == null)
                continue;

            if(resultIronman == null || resultRegular != null && resultRegular[1] < resultIronman[1]){
                positions.push({
                    leaderboard,
                    rank: resultRegular[1] + 1
                });
            }else{
                leaderboard.name += ' ♲';

                positions.push({
                    leaderboard,
                    rank: resultIronman[1] + 1,
                    mode: 'ironman'
                });
            }
        }

        /*
        for(const [index, result] of (await getRanks.exec()).entries()){
            if(result[0] != null || result[1] == null || result[1] > credentials.lbCap)
                continue;

            positions.push({ leaderboard: leaderboards[index], rank: result[1] + 1, mode: 'ironman' });
        }*/

        const getAmounts = redisClient.pipeline();

        for(const position of positions){
            let member = uuid;

            if(position.mode == 'ironman')
                member += 'i';

            getAmounts.zscore(`${modeName}lb_${position.leaderboard.key}`, member);
        }
        
        for(const [index, result] of (await getAmounts.exec()).entries()){
            const lb = constants.leaderboard(`lb_${positions[index].leaderboard.key}`);

            positions[index]['raw'] = result[1];
            positions[index]['amount'] = lb.format(result[1], lb.key);
        }

        output.positions = positions.sort((a, b) => a.rank - b.rank);

        res.json(output);
    });

    app.all('/api/v2/leaderboards', cors(), async (req, res) => {
        res.json(leaderboards);
    });

    app.all('/api/v2/gleaderboard/:lbName', cors(), async (req, res) => {
        const count = Math.min(100, req.query.count || 20)

        let page, startIndex, endIndex;

        page = Math.max(1, req.query.page || 1);

        const lb = constants.leaderboard(`lb_${req.params.lbName}`);

        const lbCount = await redisClient.zcount(`glb_${lb.key}`, "-Infinity", "+Infinity");

        if(lbCount == 0){
            res.status(404).json({ error: "Leaderboard not found." });
            return;
        }

        const output = { 
            positions: []
        };

        const maxPage = Math.floor(lbCount / count) + (lbCount % count == 0 ? 0 : 1);

        page = Math.min(page, maxPage);

        output.page = page;

        startIndex = (page - 1) * count;
        endIndex = startIndex - 1 + count;

        console.log(startIndex, endIndex);

        const results = lb.sortedBy > 0 ?
            await redisClient.zrange(`glb_${lb.key}`, startIndex, endIndex, 'WITHSCORES') :
            await redisClient.zrevrange(`glb_${lb.key}`, startIndex, endIndex, 'WITHSCORES');

        for(let i = 0; i < results.length; i += 2){
            const lbPosition = {
                rank: i / 2 + startIndex + 1,
                amount: lb.format(results[i + 1], lb.key),
                raw: results[i + 1],
                id: results[i],
                name: (await db.collection('guilds').findOne({ gid: results[i] })).name
            };

            if('self' in output && output.self.rank == lbPosition.rank)
                output.self = lbPosition;

            output.positions.push(lbPosition);
        }

        res.json(output);
    });

    app.all('/api/v2/leaderboard/:lbName', cors(), async (req, res) => {
        const count = Math.min(100, req.query.count || 20)

        const modeName = req.query.mode != null ? `${req.query.mode}_` : '';

        let page, startIndex, endIndex;

        const lb = constants.leaderboard(`lb_${req.params.lbName}`);

        const lbCount = await redisClient.zcount(`${modeName}lb_${lb.key}`, "-Infinity", "+Infinity");

        if(lbCount == 0){
            res.status(404).json({ error: "Leaderboard not found." });
            return;
        }

        const output = { 
            positions: []
        };

        let uuid;

        if(req.query.find || req.query.guild)
            uuid = (await getUserObject(req.query.guild || req.query.find, db, true)).uuid;

        if(uuid && req.cacheOnly == false)
            await lib.getProfile(db, uuid, null, { cacheOnly: false, waitForLb: true });

        if(req.query.guild){
            page = Math.max(1, req.query.page || 1);
            
            const guildMemberObj = await db
            .collection('guildMembers')
            .findOne({ uuid });

            if(guildMemberObj == null){
                res.status(404).json({ error: `User not in a guild` });
                return;
            }

            const guildObj = await db
            .collection('guilds')
            .findOne({ gid: guildMemberObj.gid });

            const guildMembers = await db
            .collection('guildMembers')
            .find({ gid: guildMemberObj.gid })
            .toArray();

            const getGuildScores = redisClient.pipeline();

            for(const member of guildMembers)
                getGuildScores.zscore(`${modeName}lb_${lb.key}`, member.uuid);

            let guildScores = [];

            for(const [index, result] of (await getGuildScores.exec()).entries()){
                if(result[1] == null)
                    continue;

                guildScores.push({ uuid: guildMembers[index].uuid.substring(0, 32), score: Number(result[1]) });
            }

            if(lb.sortedBy > 0)
                guildScores = guildScores.sort((a, b) => a.score - b.score);
            else
                guildScores = guildScores.sort((a, b) => b.score - a.score);

            const maxPage = Math.floor(guildScores.length / count) + (guildScores.length % count == 0 ? 0 : 1);

            page = Math.min(page, maxPage);

            const selfRank = guildScores.map(a => { return a.uuid; }).indexOf(uuid);

            page = Math.floor(selfRank / count) + 1;

            if(req.query.page)
                page = Math.max(1, req.query.page || 1);

            output.page = page;

            startIndex = (page - 1) * count;
            endIndex = startIndex + count;

            const selfPosition = guildScores[selfRank];

            if(selfPosition){
                output.self = {
                    rank: selfRank + 1,
                    amount: lb.format(selfPosition.score, lb.key),
                    raw: selfPosition.score,
                    uuid: selfPosition.uuid.substring(0, 32),
                    username: (await getUserObject(selfPosition.uuid, db, true)).display_name,
                    guild: guildObj.name
                };
            }

            for(let i = startIndex; i < endIndex; i++){
                if(i > guildScores.length - 1)
                    break;

                const position = guildScores[i];

                const lbPosition = {
                    rank: i + 1,
                    amount: lb.format(position.score, lb.key),
                    raw: position.score,
                    uuid: position.uuid.substring(0, 32),
                    username: (await getUserObject(position.uuid, db, true)).display_name
                };

                output.positions.push(lbPosition);
            }

            res.json(output);
            return;
        }

        if(req.query.find){
            if(!req.cacheOnly)
                await lib.getProfile(db, uuid, null, { cacheOnly: false });

            let rank;

            if(lb.sortedBy > 0){
                rank = await redisClient.zrank(`${modeName}lb_${lb.key}`, uuid);

                if(rank == null)
                    rank = await redisClient.zrank(`${modeName}lb_${lb.key}`, uuid + 'i')
            }else{
                rank = await redisClient.zrevrank(`${modeName}lb_${lb.key}`, uuid);

                if(rank == null)
                    rank = await redisClient.zrevrank(`${modeName}lb_${lb.key}`, uuid + 'i')
            }

            if(rank == null){
                res.status(404).json({ error: `Specified user not in Top ${credentials.lbCap.toLocaleString()} on ${lb.name} Leaderboard.` });
                return;
            }

            output.self = { rank: rank + 1 };

            page = Math.floor(rank / count) + 1;
        }else{
            page = Math.max(1, req.query.page || 1);
        }

        const maxPage = Math.floor(lbCount / count) + (lbCount % count == 0 ? 0 : 1);

        page = Math.min(page, maxPage);

        output.page = page;

        startIndex = (page - 1) * count;
        endIndex = startIndex - 1 + count;

        const results = lb.sortedBy > 0 ?
            await redisClient.zrange(`${modeName}lb_${lb.key}`, startIndex, endIndex, 'WITHSCORES') :
            await redisClient.zrevrange(`${modeName}lb_${lb.key}`, startIndex, endIndex, 'WITHSCORES');

        for(let i = 0; i < results.length; i += 2){
            const lbPosition = {
                rank: i / 2 + startIndex + 1,
                amount: lb.format(results[i + 1], lb.key),
                raw: results[i + 1],
                uuid: results[i].substring(0, 32),
                username: (await getUserObject(results[i], db, true)).display_name
            };

            if('self' in output && output.self.rank == lbPosition.rank)
                output.self = lbPosition;

            output.positions.push(lbPosition);
        }

        res.json(output);
    });

    app.all('/api/v2/bazaar', cors(), async (req, res) => {
        await init;

        try{
            const output = {};

            for await(const product of db.collection('bazaar').find()){
                const itemInfo = productInfo[product.productId];

                const productName = itemInfo ? itemInfo.name : helper.titleCase(product.productId.replace(/(_+)/g, ' '));

                output[product.productId] = {
                    id: product.productId,
                    name: productName,
                    buyPrice: product.buyPrice,
                    sellPrice: product.sellPrice,
                    buyVolume: product.buyVolume,
                    sellVolume: product.sellVolume,
                    tag: helper.hasPath(itemInfo, 'tag') ? itemInfo.tag : null,
                    price: (product.buyPrice + product.sellPrice) / 2
                };
            }

            res.json(output);
        }catch(e){
            handleError(e, res);
        }
    });

    app.all('/api/v2/profile/:player', cors(), async (req, res) => {
        try{
            const { profile, allProfiles } = await lib.getProfile(db, req.params.player, null, { cacheOnly: req.cacheOnly });

            const output = { profiles: {} };

            for(const singleProfile of allProfiles){
                if(singleProfile.members[profile.uuid] == null)
                    continue;

                const userProfile = singleProfile.members[profile.uuid];

                const items = await lib.getItems(userProfile, req.query.pack);
                const data = await lib.getStats(db, singleProfile, allProfiles, items);

                output.profiles[singleProfile.profile_id] = {
                    profile_id: singleProfile.profile_id,
                    cute_name: singleProfile.cute_name,
                    game_mode: singleProfile.game_mode,
                    current: Math.max(...allProfiles.map(a => a.members[profile.uuid] != null 
                        && a.members[profile.uuid].last_save)) == userProfile.last_save,
                    last_save: userProfile.last_save,
                    raw: userProfile,
                    items,
                    data
                };
            }

            res.json(output);
        }catch(e){
            handleError(e, res);
        }
    });

    setInterval(initFunction, 1000 * 60);
};
