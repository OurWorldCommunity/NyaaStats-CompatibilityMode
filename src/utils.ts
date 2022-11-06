/// <reference types="../types/minecraft" />
/// <reference types="../types/nyaa-stats" />

import fs from 'fs-extra'
import path from 'path'
import axios from 'axios'
import NBT from 'mcnbt'

import loadConfig from './config'
import {defaultSkin, delay, download, mergeStats, writeJSON} from './helper'
import * as logger from './logger'

const config = loadConfig()
const outputDir = config.resolve(config.render.output)
const playersPath = path.join(outputDir, 'players.json')
const oldPlayers: NSPlayerInfoData[] | null = fs.existsSync(playersPath) ? fs.readJsonSync(playersPath) : null

export default class Utils {
  apiLimited: boolean

  constructor () {
    this.apiLimited = false
  }

  getWorldTime (): Promise<number> {
    const nbt = new NBT()
    return new Promise((resolve, reject) => {
      nbt.loadFromZlibCompressedFile(
        path.join(config.get<string>('render.level')),
        (err) => {
          if (err) return reject(err)
          return resolve(Number(BigInt(nbt.select('').select('Data').select('Time').getValue())) / 20)
        },
      )
    })
  }

  getAllPlayers (): LongUuid[] {
    const uuids: LongUuid[] = []
    const r = new RegExp(/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i)
    fs.readdirSync(path.join(config.get<string>('render.playerdata'))).forEach((f) => {
      const uuid = path.basename(f, '.dat')
      // filter out old player usernames.
      if (r.test(uuid)) {
        uuids.push(uuid)
      }
    })
    return uuids
  }

  getWhitelistedPlayers (): LongUuid[] {
    const uuids: LongUuid[] = []
    JSON.parse(fs.readFileSync(config.get<string>('render.whitelist'), 'utf8')).forEach((p: McWhitelistRecord) => {
      uuids.push(p.uuid)
    })
    return uuids
  }

  getBannedPlayers (): LongUuid[] {
    const banlist: LongUuid[] = []
    const banned = JSON.parse(fs.readFileSync(path.join(config.get<string>('render.banned-players')), 'utf8')) as McBannedPlayersJson
    banned.forEach((ban) => {
      banlist.push(ban.uuid)
    })
    return banlist
  }

  getPlayerState (uuid: LongUuid): Promise<{merged: McPlayerStatsJson, source: McPlayerStatsJson}> {
    return new Promise((resolve, reject) => {
      if (!config.get('render.stats')) return reject()
      const statsfile = path.join(config.get<string>('render.stats'), `${uuid}.json`)
      let data: string | McPlayerStatsJson
      try {
        data = fs.readFileSync(statsfile, 'utf-8') as string
        logger.PlayerData.info('READ', statsfile)
        data = JSON.parse(data) as McPlayerStatsJson
        return resolve({
          merged: mergeStats(data),
          source: data,
        })
      } catch (error) {
        logger.PlayerData.warn('READ', statsfile, error.toString())
        return resolve({merged: {}, source: {}})
      }
    })
  }

  getPlayerAdvancements (uuid: LongUuid): Promise<McPlayerAdvancementsJson> {
    return new Promise((resolve, reject) => {
      // compatible to 1.11
      if (!config.get('render.advancements')) return reject()
      const advancementsfile = path.join(config.get<string>('render.advancements'), `${uuid}.json`)

      let data: string
      try {
        data = fs.readFileSync(advancementsfile, 'utf-8') as string
        logger.PlayerData.info('READ', advancementsfile)
        return resolve(JSON.parse(data))
      } catch (error) {
        logger.PlayerData.warn('READ', advancementsfile, error.toString())
        return resolve({})
      }
    })
  }

  getPlayerData (uuid: LongUuid): Promise<NSPlayerInfoData> {
    const datafile = path.join(config.get<string>('render.playerdata'), `${uuid}.dat`)
    return new Promise((resolve, reject) => {
      const nbt = new NBT()
      nbt.loadFromZlibCompressedFile(datafile, async (err) => {
        if (err) {
          logger.PlayerData.warn('READ', datafile, err.toString())
          return reject()
        }
        logger.PlayerData.info('READ', datafile)
        const uuidShort = uuid.replace(/-/g, '')
        let history = oldPlayers?.find(p => p.uuid === uuidShort)?.names ?? null
        if (!history) {
          const name = await this.getCurrentName(uuid)
          history = name ? [{name, detectedAt: Date.now()}] : null
        }
        if (history && history[0]) {
          let lived: number | undefined
          if (nbt.select('').select('Spigot.ticksLived')) {
            lived = (nbt.select('').select('Spigot.ticksLived').getValue() as number) / 20
          }
          const timeStart = nbt.select('').select('bukkit')
            ? Number(BigInt(nbt.select('').select('bukkit').select('firstPlayed').getValue()))
            : undefined
          const timeLast = nbt.select('').select('bukkit')
            ? Number(BigInt(nbt.select('').select('bukkit').select('lastPlayed').getValue()))
            : undefined
          const pdata: NSPlayerInfoData = {
            seen: timeLast,
            time_start: timeStart,
            time_last: timeLast,
            time_lived: lived,
            playername: history[0].name,
            names: history,
            uuid_short: uuidShort,
            lastUpdate: (new Date()).valueOf(),
            uuid,
          }
          return resolve(pdata)
        }
        return reject()
      })
    })
  }

  async getPlayerTotalData (uuid: LongUuid): Promise<NSPlayerStatsJson | null> {
    let s
    let stats
    let stats_source
    let advancements
    let data
    try {
      s = await this.getPlayerState(uuid)
      stats = s['merged']
      stats_source = s['source']
      advancements = await this.getPlayerAdvancements(uuid)
      data = await this.getPlayerData(uuid)
    } catch (error) {
      return null
    }
    return {
      stats,
      stats_source,
      advancements,
      data,
    }
  }

  async getCurrentName (uuid: LongUuid): Promise<string | null> {
    
    let apiProfile = config.get('render.bs_skin') ? config.get<string>('render.bs_skin')+'/api/yggdrasil/sessionserver/session/minecraft/profile/'+uuid.replace(/-/g,'') : `https://sessionserver.mojang.com/session/minecraft/profile/${uuid}`
    let profile
    try {
      profile = await this.getMojangAPI<McPlayerProfile | ''>(apiProfile)
      return profile === '' ? (config.get<string>('render.def_name')?? null) : profile.name
    } catch (err) {
      return config.get<string>('render.def_name')?? null
    }
  }

  async getMojangAPI <T> (apiPath: string): Promise<T> {
    if (config.get('api.ratelimit') && this.apiLimited) {
      await delay(10)
      return this.getMojangAPI(apiPath)
    }
    this.apiLimited = true
    logger.MojangAPI.info('REQUEST', apiPath)

    let body
    try {
      const res = await axios.get(apiPath, {timeout: 30000})
      body = res.data
    } catch (err) {
      logger.MojangAPI.error('REQUEST', apiPath, err.toString())
      setTimeout(() => {
        this.apiLimited = false
      }, config.get<number>('api.ratelimit') * 3000)
      throw new Error(err)
    }

    setTimeout(() => {
      this.apiLimited = false
    }, config.get<number>('api.ratelimit') * 1000)

    return body
  }

  async getPlayerAssets (uuid: LongUuid, playerpath: string): Promise<void> {
    try {
      fs.ensureDirSync(playerpath)
    } catch (error) {
      throw new Error(error)
    }
    
    let apiPrefixAvatar
    let apiPrefixBody
    let apiPrefixSkin
    
    if (config.get('render.bs_skin')) {        
        let skin_hash
        let player_id
        
        
        try {
            player_id = await this.getCurrentName(uuid)
            let res = await axios.get(config.get('render.bs_skin')+'/'+player_id+'.json', {timeout: 30000})
            skin_hash = res.data.skins.default
        } catch (err) {
            throw new Error('请求BS玩家信息接口失败('+player_id+') -> '+err)
        }
        apiPrefixAvatar = config.get('render.bs_skin')+'/avatar/player/'+player_id+'?size=64'
        apiPrefixBody = config.get('render.bs_skin')+'/preview/hash/'+skin_hash
        apiPrefixSkin = config.get('render.bs_skin')+'/textures/'+skin_hash
    }else{
        const slim = `&default=MHF_${defaultSkin(uuid)}`
        
        apiPrefixAvatar = `${config.get('render.crafatar')}/avatars/${uuid}?size=64&overlay${slim}`
        apiPrefixBody = `${config.get('render.crafatar')}/renders/body/${uuid}?size=128&overlay${slim}`
        apiPrefixSkin = `${config.get('render.crafatar')}/skins/${uuid}?${slim}`
    }

    await download(
      apiPrefixAvatar,
      path.join(playerpath, 'avatar.png'),
    )
    await download(
      apiPrefixBody,
      path.join(playerpath, 'body.png'),
    )
    await download(
      apiPrefixSkin,
      path.join(playerpath, 'skin.png'),
    )


  }

  async createPlayerData (uuid: LongUuid, banned = false): Promise<NSPlayerStatsJson> {
    const uuidShort = uuid.replace(/-/g, '')
    const playerpath = path.join(config.get<string>('render.output'), uuidShort)
    const data = await this.getPlayerTotalData(uuid)
    if (data) {
      // Name data is currently updated only in players.json
      // so we need to duplicate it into stats.json
      const playerInfo = oldPlayers!.find(p => p.uuid === uuidShort)
      if (playerInfo) {
        data.data.playername = playerInfo.playername
        data.data.names = playerInfo.names
      }
      try {
        await this.getPlayerAssets(uuid.replace(/-/g, ''), playerpath)
      } catch (error) {
        logger.PlayerData.error('ASSETS', error.toString())
      }
      data.data = {
        ...data.data,
        banned,
      }
      writeJSON(path.join(playerpath, 'stats.json'), data as never)
      return data
    } else {
      throw new Error(`No data grabbed for player ${uuidShort}`)
    }
  }
}
