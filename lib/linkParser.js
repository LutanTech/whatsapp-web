const cheerio=require("cheerio")
const axios=require("axios")

async function parseLink(url){
    try{
        const response=await axios.get(url,{
            timeout:10000,
            headers:{
                "User-Agent":"Mozilla/5.0"
            }
        })

        const $=cheerio.load(response.data)

        const getMeta=(property,name)=>{
            return $(`meta[property="${property}"]`).attr("content")||
                   $(`meta[name="${name}"]`).attr("content")||
                   ""
        }

        return {
            url,
            title:getMeta("og:title","twitter:title")||$("title").text().trim(),
            description:getMeta("og:description","twitter:description"),
            image:getMeta("og:image","twitter:image"),
            siteName:getMeta("og:site_name",""),
            type:getMeta("og:type","")
        }
    }catch(err){
        return {url,title:"",description:"",image:"",siteName:"",type:""}
    }
}

module.exports={parseLink}