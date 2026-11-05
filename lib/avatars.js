
const avatarCache=new Map()
const fullAvatarCache=new Map()
const AVATAR_CACHE_TTL=15*60*1000

function normalizeJid(jid){
    return jid?String(jid).replace(/:\d+@/,"@"):""
}

function withTimeout(promise,milliseconds=3500){
    let timer
    return Promise.race([
        promise,
        new Promise((_,reject)=>{
            timer=setTimeout(
                ()=>reject(new Error("Profile-picture lookup timed out")),
                milliseconds
            )
        })
    ]).finally(()=>clearTimeout(timer))
}

async function resolveAvatarJids(sock,jid){
    const original=normalizeJid(jid)
    const targets=[original]

    if(original.endsWith("@lid")){
        try{
            const pn=await withTimeout(
                sock.signalRepository.lidMapping.getPNForLID(original)
            )

            if(pn){
                const normalized=normalizeJid(pn)
                if(normalized&&!targets.includes(normalized)){
                    targets.push(normalized)
                }
            }
        }catch(e){
            console.error("[AVATAR] LID resolution:",e.message)
        }
    }

    return targets
}

async function getAvatar(sock,jid,type,cache){
    if(!sock||!jid)return ""

    const original=normalizeJid(jid)
    const cached=cache.get(original)

    if(cached&&Date.now()-cached.timestamp<AVATAR_CACHE_TTL){
        return cached.url
    }

    const targets=await resolveAvatarJids(sock,original)

    for(const target of targets){
        try{
            const url=await withTimeout(
                sock.profilePictureUrl(target,type)
            )

            if(url){
                cache.set(original,{
                    url,
                    timestamp:Date.now()
                })

                return url
            }
        }catch{}
    }

    cache.set(original,{
        url:"",
        timestamp:Date.now()
    })

    return ""
}

async function getProfilePictureUrl(sock,jid){
    if(!sock||!jid)return ""

    for(const type of ["preview","image"]){
        const url=await getAvatar(sock,jid,type,avatarCache)
        if(url)return url
    }

    return ""
}

async function getFullProfilePictureUrl(sock,jid){
    return getAvatar(sock,jid,"image",fullAvatarCache)
}

function clearAvatarCache(jid){
    if(!jid)return

    const normalized=normalizeJid(jid)
    avatarCache.delete(normalized)
    fullAvatarCache.delete(normalized)
}

module.exports={
    getProfilePictureUrl,
    getFullProfilePictureUrl,
    clearAvatarCache,
    normalizeJid
}
