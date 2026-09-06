#!/usr/bin/env node

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const CONTENT_ROOT = path.join(ROOT, 'content');
const WEB_ROOT = path.join(ROOT, 'web');
const DATABASE_PATH = path.join(CONTENT_ROOT, 'database.json');

const CATEGORY_SPECS = {
  killers: { type: 'Killer', folder: 'killers' },
  survivors: { type: 'Survivor', folder: 'survivors' },
  perks: { type: 'Perk', folder: 'perks', assetFolder: 'assets/perks' },
  maps: { type: 'Map', folder: 'maps', assetFolder: 'assets/maps' },
  realms: { type: 'Map', folder: 'maps', assetFolder: 'assets/maps' },
  items: { type: 'Item', folder: 'items', extraPrefixes: ['dbd_images/powers/'] },
  offerings: { type: 'Offering', folder: 'offerings' },
  addons: { type: 'Addon', folder: 'addons' }
};

const IMAGE_ALIASES = {
  Killer: {
    'k05_thehag_portrait.png': 'K06_TheHag_Portrait.png',
    'k06_theshape_portrait.png': 'K05_TheShape_Portrait.png',
    'k16_theghostface_portrait.png': 'K16_TheGhostFace_Portrait.png',
    'k29_themastermind_portrait.png': 'K29_TheMastermind_Portrait.png',
    'k34_theyerkes_portrait.png': 'k34_thegoodguy_portrait.png',
    'k37_thedracula_portrait.png': 'k37_thedarklord_portrait.png',
    't_ui_k41_thekrasue_portrait.png': 'K41_TheKrasue_Portrait.png',
    'k42_thefirst_portrait.png': 'k42_thefirst_portrait.png'
  },
  Addon: {
    'iconaddon_ironworkertongs.png': 'iconaddon_ironworkerstongs.png',
    'iconaddon_townwatcttorch.png': 'iconaddon_townwatchstorch.png',
    'iconaddon_blacksmithhammer.png': 'iconaddon_blacksmithshammer.png',
    'iconaddon_knightcontract.png': 'iconaddon_knightscontract.png',
    'iconaddon_mapoftherealms.png': 'iconaddon_mapoftherealm.png',
    'iconaddon_awardwinningchili.png': 'iconaddon_award-winningchilli.png',
    'iconaddon_chili.png': 'iconaddon_chilli.png',
    'iconaddon_diciplinecartersnotes.png': 'iconaddon_disciplinecartersnotes.png',
    'iconaddon_diciplineclassii.png': 'iconaddon_disciplineclassii.png',
    'iconaddon_diciplineclassiii.png': 'iconaddon_disciplineclassiii.png',
    'iconaddon_moldyelectrode.png': 'iconaddon_mouldyelectrode.png',
    'iconaddon_chainsbloody.png': 'iconaddon_begrimedchains.png',
    'iconaddon_chainsgrisly.png': 'iconaddon_grislychains.png',
    'iconaddon_chainsrusted.png': 'iconaddon_rustedchains.png',
    'iconaddon_lowprochains.png': 'iconaddon_loprochains.png',
    'iconaddon_tunedcarburetor.png': 'iconaddon_tunedcarburettor.png',
    'iconaddon_bloodyfingernail.png': 'iconaddon_bloodyfingernails.png',
    'iconaddon_motherdaughterring.png': 'iconaddon_mother-daughterring.png',
    'iconaddon_renirosbloodyglove.png': 'iconaddon_renjirosbloodyglove.png',
    'iconaddon_syringe.png': 'iconaddon_anti-haemorrhagicsyringe.png',
    'iconaddon_tuftofhair.png': 'iconaddon_fragranttuftofhair.png',
    'iconaddon_thelegionbutton.png': 'iconaddon_thelegionpin.png',
    'iconaddon_smileyfacebutton.png': 'iconaddon_smileyfacepin.png',
    'iconaddon_defacedsmileybutton.png': 'iconaddon_defacedsmileypin.png',
    'iconaddon_suziesmixtape.png': 'iconaddon_susiesmixtape.png',
    'iconaddon_bloodwindstorm.png': 'iconaddon_windstorm-blood.png',
    'iconaddon_mudwindstorm.png': 'iconaddon_windstorm-mud.png',
    'iconaddon_whitewindstorm.png': 'iconaddon_windstorm-white.png',
    'iconaddon_bloodswifthunt.png': 'iconaddon_swifthunt-blood.png',
    'iconaddon_mudswifthunt.png': 'iconaddon_swifthunt-mud.png',
    'iconaddon_whiteswifthunt.png': 'iconaddon_swifthunt-white.png',
    'iconaddon_bloodshadowdance.png': 'iconaddon_shadowdance-blood.png',
    'iconaddon_whiteshadowdance.png': 'iconaddon_shadowdance-white.png',
    'iconaddon_mudblink.png': 'iconaddon_blink-mud.png',
    'iconaddon_whiteblink.png': 'iconaddon_blink-white.png',
    'iconaddon_whiteblindwarrior.png': 'iconaddon_blindwarrior-white.png',
    'iconaddon_sootthebeast.png': 'iconaddon_thebeast-soot.png',
    'iconaddon_soottheghost.png': 'iconaddon_theghost-soot.png',
    'iconaddon_sootthehound.png': 'iconaddon_thehound-soot.png',
    'iconaddon_soottheserpent.png': 'iconaddon_theserpent-soot.png',
    'iconaddon_spiritallseeing.png': 'iconaddon_allseeing-spirit.png',
    'iconaddon_jumprope.png': 'iconaddon_jumpropedreamdemon.png',
    'iconaddon_foreignplantfibers.png': 'iconaddon_foreignplantfibres.png',
    'iconaddon_sulfuricacidvial.png': 'iconaddon_sulphuricacidvial.png',
    'iconaddon_hematiteseal.png': 'iconaddon_haematiteseal.png',
    'iconaddon_moltedskin.png': 'iconaddon_moultedskin.png',
    'iconaddon_jewelry.png': 'iconaddon_jewellery.png',
    'iconaddon_jewelrybox.png': 'iconaddon_jewellerybox.png',
    'iconaddon_garishmakeupkit.png': 'iconaddon_garishmake-upkit.png',
    'iconaddon_headlinescutouts.png': 'iconaddon_headlinecut-outs.png',
    'iconaddon_neaparasite.png': 'iconaddon_ne-aparasite.png',
    'iconaddon_neversleeppills.png': 'iconaddon_never-sleeppills.png',
    'iconaddon_offbrandmotoroil.png': 'iconaddon_off-brandmotoroil.png',
    'iconaddon_slowreleasetoxin.png': 'iconaddon_slow-releasetoxin.png',
    'iconaddon_droplegknifesheath.png': 'iconaddon_drop-legknifesheath.png',
    'iconaddon_highendsapphirelens.png': 'iconaddon_high-endsapphirelens.png',
    'iconaddon_kanaianzentalisman.png': 'iconaddon_kanai-anzentalisman.png',
    'iconaddon_coffeegrinds.png': 'iconaddon_coffeegrounds.png',
    'iconaddon_gauseroll.png': 'iconaddon_gauzeroll.png',
    'iconaddon_nightvisionmoncular.png': 'iconaddon_nightvisionmonocular.png',
    'iconaddon_juniperbonzai.png': 'iconaddon_juniperbonsai.png',
    'iconaddon_iridiscentcrystalshard.png': 'iconaddon_iridescentcrystalshard.png',
    'iconaddon_vermillionwebcap.png': 'iconaddon_vermilionwebcap.png',
    'iconaddon_jillsandwich.png': 'iconaddon_jillssandwich.png',
    'iconaddon_maidenmedalliom.png': 'iconaddon_maidenmedallion.png',
    'iconaddon_prototypeclaw.png': 'iconaddon_prototypeclaws.png',
    'iconaddon_razerwire.png': 'iconaddon_razorwires.png',
    'iconaddon_redheadspinkyfinger.png': 'iconaddon_redheadspinkiefinger.png',
    'iconaddon_thebeastsmark.png': 'iconaddon_thebeastsmarks.png',
    'iconaddon_honeylocustthorns.png': 'iconaddon_honeylocustthorn.png',
    'iconaddon_goldchalice.png': 'iconaddon_chalicegold.png',
    'iconaddon_stampodd.png': 'iconaddon_oddstamp.png',
    'iconaddon_reusuablecinchstraps.png': 'iconaddon_cinchstraps.png',
    'iconaddon_ether15.png': 'iconaddon_ether15vol.png',
    'iconaddon_coilskit4.png': 'iconaddon_4-coilspringkit.png',
    'iconaddon_rulessetn2.png': 'iconaddon_rulessetno.2.png',
    'iconaddon_muddysportcap.png': 'iconaddon_muddysportsdaycap.png',
    'iconaddon_uniquering.png': 'iconaddon_uniqueweddingring.png',
    'iconaddon_clearcreekwhiskey.png': 'iconaddon_goldcreekwhiskey.png',
    'iconaddon_catatonictreasure.png': 'iconaddon_catatonicboystreasure.png',
    'iconaddon_pocketwatch.png': 'iconaddon_pocketwatchspencerslastbreath.png',
    'iconaddon_carburetortuningguide.png': 'iconaddon_carburettortuningguide.png',
    'iconaddon_prayerapple.png': 'iconaddon_blessedapple.png',
    'iconaddon_bloodiedblackhood.png': 'iconaddon_bloodyblackhood.png',
    'iconaddon_tvirussample.png': 'iconaddon_t-virussample.png',
    'iconaddon_briansintestines.png': 'iconaddon_briansintestine.png',
    'iconaddon_jacobsbabyshoes.png': 'iconaddon_matiasbabyshoes.png',
    'iconaddon_iridescentvhstape.png': 'iconaddon_iridescentvideotape.png',
    'iconaddon_vhscopy.png': 'iconaddon_videotapecopy.png',
    'iconaddon_tilingblade.png': 'iconaddon_tillingblade.png',
    'iconaddon_worrystones.png': 'iconaddon_worrystone.png',
    'iconaddon_airfreshner.png': 'iconaddon_airfreshener.png',
    'iconaddon_flaminghairspray.png': 'iconaddon_hairspraycandle.png',
    'iconaddon_uroborusvirus.png': 'iconaddon_uroborosvirus.png',
    'iconaddon_adivalente1.png': 'iconaddon_adivalenteissue1.png',
    'iconaddon_highpowerfloodlight.png': 'iconaddon_high-powerfloodlight.png',
    'iconaddon_highcurrentupgrade.png': 'iconaddon_high-currentupgrade.png',
    'iconaddon_lowpowermode.png': 'iconaddon_low-powermode.png',
    'iconaddon_randomizedstrobes.png': 'iconaddon_randomisedstrobes.png',
    'iconaddon_infaredupgrade.png': 'iconaddon_infraredupgrade.png',
    'iconaddon_ultrasonictrapspeaker.png': 'iconaddon_ultrasonicspeaker.png',
    'iconaddon_overcharge.png': 'iconaddon_supercharge.png',
    'icons_addon_mementoblades.png': 'iconaddon_mementoblades.png',
    'icons_addon_trickpouch.png': 'iconaddon_trickpouch.png',
    'icons_addon_killingpartchords.png': 'iconaddon_killingpartchords.png',
    'icons_addon_infernowires.png': 'iconaddon_infernowires.png',
    'icons_addon_jiwoonsautograph.png': 'iconaddon_ji-woonsautograph.png',
    'icons_addon_ontargetsingle.png': 'iconaddon_ontargetsingle.png',
    'icons_addon_luckyblade.png': 'iconaddon_luckyblade.png',
    'icons_addon_cagedheartshoes.png': 'iconaddon_cagedheartshoes.png',
    'icons_addon_tequilamoonrock.png': 'iconaddon_tequilamoonrock.png',
    'icons_addon_bloodyboa.png': 'iconaddon_bloodyboa.png',
    'icons_addon_fizzspinsoda.png': 'iconaddon_fizz-spinsoda.png',
    'icons_addon_waitingforyouwatch.png': 'iconaddon_waitingforyouwatch.png',
    'icons_addon_ripperbrace.png': 'iconaddon_ripperbrace.png',
    'icons_addon_yumismurder.png': 'iconaddon_melodiousmurder.png',
    'icons_addon_diamondcufflinks.png': 'iconaddon_diamondcufflinks.png',
    'icons_addon_edgeofrevivalalbum.png': 'iconaddon_edgeofrevivalalbum.png',
    'icons_addon_trickblades.png': 'iconaddon_trickblades.png',
    'icons_addon_cutthruusingle.png': 'iconaddon_cutthruusingle.png',
    'icons_addon_deaththroescompilation.png': 'iconaddon_deaththroescompilation.png',
    'icons_addon_iridescentphotocard.png': 'iconaddon_iridescentphotocard.png',
    'iconaddon_threadedfilament.png': 'iconaddon_lowampfilament.png',
    'iconaddon_brokenflashlightbulb.png': 'iconaddon_brokenbulb.png',
    'iconaddon_tokengold.png': 'iconaddon_goldtoken.png',
    'iconaddon_ropeyellow.png': 'iconaddon_yellowwire.png',
    'iconaddon_blightedserum.png': 'iconaddon_blightserum.png',
    'iconaddon_blightedsyringe.png': 'iconaddon_blightserum.png',
    't_ui_iconiaddon_friendshipcharm.png': 'iconaddon_friendshipcharm.png',
    'iconaddon_mudbaikrakaeug.png': 'iconaddon_blindwarrior-mud.png',
    'iconaddon_bloodkrafabai.png': 'iconaddon_allseeing-blood.png',
    'iconaddon_whitekuntintakkho.png': 'iconaddon_swifthunt-white.png',
    'iconaddon_goldenegg.png': 'iconaddon_egggold.png',
    't_ui_iconaddon_iridescentsoteriachip.png': 'iconaddon_iridescentsoteriachip.png',
    'iconaddon_blondehair.png': 'iconaddon_blondhair.png',
    'iconaddon_metalsaw.png': 'iconaddon_hacksaw.png'
  },
  Item: {
    'iconitems_toolbox_anniversary2021.png': 'iconitems_anniversarytoolbox.png',
    'iconitems_flashlight_anniversary2020.png': 'iconitems_anniversaryflashlight.png',
    'iconitems_flashlight_anniversary2022.png': 'iconitems_masqueradeflashlight.png',
    'iconitems_medkit_anniversary2020.png': 'iconitems_anniversarymedkit.png',
    'iconitems_medkit_anniversary2022.png': 'iconitems_masquerademedkit.png',
    'iconitems_toolbox_anniversary2022.png': 'iconitems_masqueradetoolbox.png',
    'iconitems_partypopper.png': 'iconitems_thirdyearpartystarter.png',
    't_ui_iconitems_crypticmap.png': 'iconitems_crypticmap.png',
    'iconitems_bloodmap.png': 'iconitems_bloodsensemap.png',
    'iconitems_toolboxlunar.png': 'iconitems_festivetoolbox.png',
    't_ui_iconitems_artisansfogvial.png': 'iconitems_artisansfogvial.png',
    't_ui_iconitems_apprenticesfogvial.png': 'iconitems_apprenticesfogvial.png',
    't_ui_iconitems_vigosfogvial.png': 'iconitems_vigosfogvial.png',
    'iconitems_limiteditemvaccine.png': 'iconitems_vaccine.png',
    'iconitems_flashbanggrenade.png': 'iconitems_flashgrenade.png',
    't_ui_iconitems_limitedjerrycan.png': 'iconitems_jerrycan.png',
    'iconitems_limitedstabilizingspray.png': 'iconitems_firstaidspray.png',
    'iconitems_limitedemp.png': 'iconitems_emp.png',
    'iconitems_limitedrepairedmirror.png': 'iconitems_pocketmirror.png',
    'iconitems_limitedlamentconfiguration.png': 'iconitems_lamentconfiguration.png'
  },
  Offering: {
    'iconfavors_momentomoricypress.png': 'iconfavors_cypressmementomori.png',
    'iconfavors_momentomoriebony.png': 'iconfavors_ebonymementomori.png',
    'iconfavors_momentomoriivory.png': 'iconfavors_ivorymementomori.png',
    'iconfavors_wardblack.png': 'iconfavors_blackward.png',
    'iconfavors_wardwhite.png': 'iconfavors_whiteward.png',
    'iconfavors_wardsacrificial.png': 'iconfavors_sacrificialward.png',
    'iconfavors_macmillianledgerpage.png': 'iconfavors_macmillanledgerpage.png',
    'iconfavors_macmilliansphalanxbone.png': 'iconfavors_macmillansphalanxbone.png',
    'iconfavors_yamaokascrest.png': 'iconfavors_yamaokafamilycrest.png',
    'iconfavors_crecentmoonbouquet.png': 'iconfavors_crescentmoonbouquet.png',
    'iconfavors_plateshredded.png': 'iconfavors_shreddedplate.png',
    'iconfavors_platevirginia.png': 'iconfavors_virginiaplate.png',
    'iconfavors_redmoneypacket.png': 'iconfavors_redenvelope.png',
    'iconfavors_arcanedowsingrod.png': 'iconfavors_arcanedousingrod.png',
    'iconfavors_4thanniversary.png': 'iconfavors_ghastlygateau.png',
    'iconsfavors_5thanniversary.png': 'iconfavors_sacrificialcake.png',
    'iconsfavors_6thanniversary.png': 'iconfavors_frightfulflan.png',
    'iconsfavors_7thanniversary.png': 'iconfavors_terrormisu.png',
    'iconsfavors_8thanniversary.png': 'iconfavors_screechcobbler.png',
    't_ui_iconsfavors_9thanniversary.png': 'iconfavors_9thanniversary.png',
    'iconsfavors_rpdbadge.png': 'iconfavors_rpdbadge.png',
    'iconsfavors_winter.png': 'iconfavors_mistletoes.png',
    't_ui_iconsfavors_shroudofvanishing.png': 'iconfavors_shroudofvanishing.png',
    'iconfavors_jarofsaltylips.png': 'iconfavors_vigosjarofsaltylips.png'
  },
  Survivor: {
    's08_williambilloverbeck_portrait.png': 'S08_BillOverbeck_Portrait.png',
    's12_detectivedavidtapp_portrait.png': 'S12_DavidTapp_Portrait.png',
    's17_ashleyjwilliams_portrait.png': 'S17_AshWilliams_Portrait.png',
    's18_steveharrington_portrait.png': 'S19_SteveHarrington_Portrait.png',
    's19_nancywheeler_portrait.png': 'S18_NancyWheeler_Portrait.png',
    's25_yunjinlee_portrait.png': 'S25_Yun-JinLee_Portrait.png',
    's27_leonskennedy_portrait.png': 'S27_LeonScottKennedy_Portrait.png',
    't_ui_s49_veeboonyasak_portrait.png': 'S49_VeeBoonyasak_Portrait.png',
    's50_eleven_portrait.png': 'S50_Eleven_Portrait.png',
    's51_dustinhenderson_portrait.png': 'S51_DustinHenderson_Portrait.png'
  },
  Perk: {
    'iconperks_awakenedawarenesss.png': 'IconPerks_Awakened Awareness.png',
    'iconperks_awakenedawareness.png': 'IconPerks_Awakened Awareness.png',
    'iconperks_bbqandchili.png': 'IconPerks_barbecueAndChilli.png',
    'iconperks_boondestroyer.png': 'IconPerks_shatteredHope.png',
    'iconperks_cruelconfinement.png': 'IconPerks_cruelLimits.png',
    'iconperks_deadmanswitch.png': 'IconPerks_deadMansSwitch.png',
    'iconperks_flipflop.png': 'IconPerks_flip-Flop.png',
    'iconperks_franklinsloss.png': 'IconPerks_franklinsDemise.png',
    'iconperks_generatorovercharge.png': 'IconPerks_overcharge.png',
    'iconperks_hangmanstrick.png': 'IconPerks_scourgeHookHangmansTrick.png',
    'iconperks_devourhope.png': 'IconPerks_hexDevourHope.png',
    'iconperks_hauntedground.png': 'IconPerks_hexHauntedGround.png',
    'iconperks_huntresslullaby.png': 'IconPerks_hexHuntressLullaby.png',
    'iconperks_ruin.png': 'IconPerks_hexRuin.png',
    'iconperks_thethirdseal.png': 'IconPerks_hexTheThirdSeal.png',
    'iconperks_thrillofthehunt.png': 'IconPerks_hexThrillOfTheHunt.png',
    'iconperks_hexbloodfavor.png': 'IconPerks_hexBloodFavour.png',
    'iconperks_coupdegrace.png': 'IconPerks_coupDeGrâce.png',
    't_iconperks_painresonance.png': 'IconPerks_scourgeHookPainResonance.png',
    'iconperks_painresonance.png': 'IconPerks_scourgeHookPainResonance.png',
    'iconperks_floodofrage.png': 'IconPerks_scourgeHookFloodsOfRage.png',
    'iconperks_darknessrevelated.png': 'IconPerks_darknessRevealed.png',
    'iconperks_selfaware.png': 'IconPerks_machineLearning.png',
    'iconperks_twocanplay.png': 'IconPerks_hexTwoCanPlay.png',
    'iconperks_friendstilltheend.png': 'IconPerks_friendsTilTheEnd.png',
    'iconperks_monstrousshrine.png': 'IconPerks_scourgeHookMonstrousShrine.png',
    'iconperks_nooneescapesdeath.png': 'IconPerks_hexNoOneEscapesDeath.png',
    'iconperks_openhanded.png': 'IconPerks_open-Handed.png',
    'iconperks_hatred.png': 'IconPerks_rancor.png',
    'iconperks_darktheory.png': 'IconPerks_boonDarkTheory.png',
    'iconperks_vittoriosgambit.png': 'IconPerks_quickGambit.png',
    'iconperks_lightfooted.png': 'IconPerks_light-Footed.png',
    'iconsperks_illumination.png': 'IconPerks_boonIllumination.png',
    'iconperks_selfcare.png': 'IconPerks_self-Care.png',
    'iconperks_thatanophobia.png': 'IconPerks_thanatophobia.png'
  },
  Map: {
    'iconmap_apl_level01.png': 'IconMap_Apl_Level02.png',
    'iconmap_apl_level02.png': 'IconMap_Apl_Level02.png',
    't_ui_iconmap_apl_shack.png': 'IconMap_Apl_Shack.png',
    'iconmap_asy_asylum.png': 'IconMap_Asy_Asylum.png',
    'iconmap_asy_chapel.png': 'IconMap_Asy_Chapel.png',
    'iconmap_brl_mahouse.png': 'IconMap_Brl_MadHouse.png',
    'iconmap_brl_madhouse.png': 'IconMap_Brl_MadHouse.png',
    'iconmap_brl_temple.png': 'IconMap_Brl_Temple.png',
    'iconmap_ecl_level01.png': 'IconMap_Ecl_Eclipselevel01.png',
    'iconmap_orion_level01.png': 'IconMap_Ecl_Orionlevel01.png',
    'iconmap_eng_elmstreet.png': 'IconMap_Eng_Elmstreet.png',
    'iconmap_eng_elmstreet02.png': 'IconMap_Eng_ElmstreetII.png',
    'iconmap_eng_elmstreet03.png': 'IconMap_Eng_ElmstreetIII.png',
    'iconmap_eng_elmstreet04.png': 'IconMap_Eng_ElmstreetIV.png',
    'iconmap_eng_elmstreet05.png': 'IconMap_Eng_ElmstreetV.png',
    'iconmap_fin_thegame.png': 'IconMap_Fin_TheGame.png',
    'iconmap_frm_barn.png': 'IconMap_Frm_Barn.png',
    'iconmap_frm_cornfield.png': 'IconMap_Frm_Cornfield.png',
    'iconmap_frm_farmhouse.png': 'IconMap_Frm_Farmhouse.png',
    'iconmap_frm_silo.png': 'IconMap_Frm_Silo.png',
    'iconmap_frm_slaughterhouse.png': 'IconMap_Frm_Slaughterhouse.png',
    'iconmap_glo_level01.png': 'IconMap_Glo_Level01.png',
    'iconmap_hos_treatment.png': 'IconMap_Hos_Treatment.png',
    'iconmap_hti_manor1.png': 'IconMap_Hti_Manor.png',
    'iconmap_hti_manor2.png': 'IconMap_Hti_Manor.png',
    'iconmap_hti_shrine1.png': 'IconMap_Hti_Shrine.png',
    'iconmap_hti_shrine2.png': 'IconMap_Hti_Shrine.png',
    'iconmap_ice_level01.png': 'IconMap_Ice_Level01.png',
    'iconmap_ind_coaltower1.png': 'IconMap_Ind_CoalTower.png',
    'iconmap_ind_coaltower2.png': 'IconMap_Ind_CoalTower.png',
    'iconmap_ind_forest1.png': 'IconMap_Ind_Forest.png',
    'iconmap_ind_forest2.png': 'IconMap_Ind_Forest.png',
    'iconmap_ind_foundry1.png': 'IconMap_Ind_Foundry.png',
    'iconmap_ind_foundry2.png': 'IconMap_Ind_Foundry.png',
    'iconmap_ind_mine1.png': 'IconMap_Ind_Mine.png',
    'iconmap_ind_mine2.png': 'IconMap_Ind_Mine.png',
    'iconmap_ind_storehouse1.png': 'IconMap_Ind_Storehouse.png',
    'iconmap_ind_storehouse2.png': 'IconMap_Ind_Storehouse.png',
    'iconmap_ion_level01.png': 'IconMap_Ion_Ionlevel01.png',
    'iconmap_jnk_garage.png': 'IconMap_Jnk_Garage.png',
    'iconmap_jnk_gasstation.png': 'IconMap_Jnk_GasStation.png',
    'iconmap_jnk_lodge.png': 'IconMap_Jnk_Lodge.png',
    'iconmap_jnk_office.png': 'IconMap_Jnk_Office.png',
    'iconmap_jnk_scrapyard.png': 'IconMap_Jnk_Scrapyard.png',
    'iconmap_kny_cottage1.png': 'IconMap_Kny_Cottage.png',
    'iconmap_kny_cottage2.png': 'IconMap_Kny_Cottage.png',
    'iconmap_kny_cottage3.png': 'IconMap_Kny_Cottage.png',
    'iconmap_meteor_level01.png': 'IconMap_Meteor_Meteorlevel01.png',
    'iconmap_qat_lab.png': 'IconMap_Qat_Laboratory.png',
    'iconmap_qtm_level01.png': 'IconMap_Qtm_Quantumlevel01.png',
    'iconmap_qtm_level02.png': 'IconMap_Qtm_Churroslevel01.png',
    'iconmap_sub_street.png': 'IconMap_Sub_Street.png',
    'iconmap_swp_grimpantry.png': 'IconMap_Swp_GrimPantry.png',
    'iconmap_swp_palerose.png': 'IconMap_Swp_ThePaleRose.png',
    'iconmap_ukr_saloon.png': 'IconMap_Ukr_Saloon.png',
    'iconmap_uba_level01.png': 'IconMap_Uba_Umbralevel01.png',
    'iconmap_wal_level01.png': 'IconMap_Wal_Level01.png',
    'iconmap_wrm_level01.png': 'IconMap_Uba_Wormholelevel01.png'
  }
};

const KILLER_POWER_ITEM_TO_KILLER = {
  Item_Slasher_Beartrap: 'The Trapper',
  Item_Slasher_Blinker: 'The Nurse',
  Item_Slasher_Chainsaw: 'The Hillbilly',
  Item_Slasher_CloakBell: 'The Wraith',
  Item_Slasher_DreamInducer: 'The Nightmare',
  Item_Slasher_Frenzy: 'The Legion',
  Item_Slasher_GasBomb: 'The Clown',
  Item_Slasher_GhostPower: 'The Ghost Face',
  Item_Slasher_HarpoonRifle: 'The Deathslinger',
  Item_Slasher_Hatchet: 'The Huntress',
  Item_Slasher_K21Power: 'The Blight',
  Item_Slasher_K22Power: 'The Twins',
  Item_Slasher_K24Power: 'The Nemesis',
  Item_Slasher_K25Power: 'The Cenobite',
  Item_Slasher_K26Power: 'The Artist',
  Item_Slasher_K27Power: 'The Onryō',
  Item_Slasher_K28Power: 'The Dredge',
  Item_Slasher_K29Power: 'The Mastermind',
  Item_Slasher_K30Power: 'The Knight',
  Item_Slasher_K31Power: 'The Skull Merchant',
  Item_Slasher_K32Power: 'The Singularity',
  Item_Slasher_K33Power: 'The Xenomorph',
  Item_Slasher_K34Power: 'The Good Guy',
  Item_Slasher_K35Power: 'The Unknown',
  Item_Slasher_K36Power: 'The Lich',
  Item_Slasher_K37Power: 'The Dark Lord',
  Item_Slasher_K38Power: 'The Houndmaster',
  Item_Slasher_K39Power: 'The Ghoul',
  Item_Slasher_K40Power: 'The Animatronic',
  Item_Slasher_K41Power: 'The Krasue',
  Item_Slasher_K42Power: 'The First',
  Item_K43Power: 'The Slasher',
  Item_K44Power: 'The Judgment',
  Item_Slasher_Kanobo: 'The Oni',
  Item_Slasher_Killer07Item: 'The Doctor',
  Item_Slasher_LFChainsaw: 'The Cannibal',
  Item_Slasher_PhantomTrap: 'The Hag',
  Item_Slasher_PhaseWalker: 'The Spirit',
  Item_Slasher_PlaguePower: 'The Plague',
  Item_Slasher_QatarKillerPower: 'The Demogorgon',
  Item_Slasher_ReverseBearTrap: 'The Pig',
  Item_Slasher_Stalker: 'The Shape',
  Item_Slasher_ThrowingKnives: 'The Trickster',
  Item_Slasher_TormentMode: 'The Executioner'
};

const ITEM_PLACEHOLDERS = new Set([
  'Item_Camper_K36MagicItem_Boots',
  'Item_Camper_K36MagicItem_Bracers'
]);

function fail(message) {
  console.error(`normalize-images: ${message}`);
  process.exit(1);
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function normalizeLocalPath(value) {
  return String(value || '').replace(/\\/g, '/').replace(/^\.\//, '');
}

function isExplicitLocalImagePath(value) {
  const normalized = normalizeLocalPath(value);
  return normalized.startsWith('assets/') || normalized.startsWith('dbd_images/');
}

function addPrefixVariants(variants, value) {
  if (!value) return;
  variants.add(value);
  variants.add(value.replace(/^iconperks/i, 'IconPerks'));
  variants.add(value.replace(/^iconsperks/i, 'IconPerks'));
  variants.add(value.replace(/^t_ui_iconperks/i, 'T_UI_iconPerks'));
  variants.add(value.replace(/^t_ui_iconsperks/i, 'T_UI_iconPerks'));
}

function buildPerkCandidates(withExt) {
  const variants = new Set();
  const addAll = (value) => {
    addPrefixVariants(variants, value);
    if (value) addPrefixVariants(variants, value[0].toLowerCase() + value.slice(1));
    if (value) {
      const dot = value.lastIndexOf('.');
      const name = dot >= 0 ? value.slice(0, dot) : value;
      const ext = dot >= 0 ? value.slice(dot) : '';
      const underscore = name.lastIndexOf('_');
      const loweredTail = underscore >= 0
        ? `${name.slice(0, underscore + 1)}${name.slice(underscore + 1, underscore + 2).toLowerCase()}${name.slice(underscore + 2)}`
        : `${name.slice(0, 1).toLowerCase()}${name.slice(1)}`;
      addPrefixVariants(variants, loweredTail + ext);
    }
    addPrefixVariants(variants, value ? value.toLowerCase() : value);
  };
  const stripExt = (value) => value.replace(/\.[^/.]+$/, '');

  addAll(withExt);
  const withoutTUI = withExt.replace(/^T_UI_/i, '');
  addAll(withoutTUI);
  const withoutT = withExt.replace(/^T_/i, '');
  addAll(withoutT);
  const baseName = stripExt(withoutTUI.replace(/^T_/i, ''));
  addAll(`${baseName.replace(/([a-z])([A-Z])/g, '$1-$2')}.png`);

  return Array.from(variants);
}

function buildMapCandidates(withExt) {
  const variants = new Set();
  const addVariant = (value) => {
    if (!value) return;
    variants.add(value);
  };

  addVariant(withExt);
  const withoutTUI = withExt.replace(/^T_UI_/i, '');
  addVariant(withoutTUI);
  addVariant(withoutTUI.replace(/^iconmap/i, 'IconMap'));
  addVariant(withExt.toLowerCase());

  const match = withoutTUI.match(/iconmap_([a-z]+)_/i);
  if (match) {
    const realmCode = match[1];
    addVariant(`IconMap_${realmCode}_Level01.png`);
    addVariant(`IconMap_${realmCode}_Level02.png`);
    addVariant(`IconMap_${realmCode}level01.png`);
  }

  const mapAliases = {
    'iconmap_brl_mahouse.png': 'IconMap_Brl_MadHouse.png',
    'iconmap_ecl_level01.png': 'IconMap_Ecl_Eclipselevel01.png',
    'iconmap_orion_level01.png': 'IconMap_Ecl_Orionlevel01.png',
    'iconmap_eng_elmstreet.png': 'IconMap_Eng_Elmstreet.png',
    'iconmap_ind_forest2.png': 'IconMap_Ind_Forest.png',
    'iconmap_glo_level01.png': 'IconMap_Glo_Level01.png',
    'iconmap_apl_level01.png': 'IconMap_Apl_Level02.png'
  };
  const aliasKey = withoutTUI.toLowerCase();
  if (mapAliases[aliasKey]) addVariant(mapAliases[aliasKey]);

  return Array.from(variants);
}

function getDirectoryEntries(dirPath) {
  if (!fs.existsSync(dirPath)) return new Map();
  return new Map(fs.readdirSync(dirPath).map((entry) => [entry.toLowerCase(), entry]));
}

function getAllowedPrefixes(spec) {
  const prefixes = [`dbd_images/${spec.folder}/`];
  if (spec.assetFolder) prefixes.push(`${spec.assetFolder}/`);
  if (spec.extraPrefixes) prefixes.push(...spec.extraPrefixes);
  return prefixes;
}

function getLookupCache(webRoot) {
  const cache = new Map();
  return (relativeDir) => {
    if (!cache.has(relativeDir)) {
      cache.set(relativeDir, getDirectoryEntries(path.join(webRoot, relativeDir)));
    }
    return cache.get(relativeDir);
  };
}

function resolveExplicitLocalPath(spec, image, getDirEntries) {
  const normalized = normalizeLocalPath(image);
  if (!isExplicitLocalImagePath(normalized)) return null;

  for (const prefix of getAllowedPrefixes(spec)) {
    if (!normalized.startsWith(prefix)) continue;
    const fileName = normalized.slice(prefix.length);
    const entries = getDirEntries(prefix.slice(0, -1));
    const actual = entries.get(fileName.toLowerCase());
    if (actual) return `${prefix}${actual}`;
  }

  return null;
}

function resolveCandidateInFolder(folder, candidate, getDirEntries) {
  const entries = getDirEntries(`dbd_images/${folder}`);
  const actual = entries.get(candidate.toLowerCase());
  return actual ? `dbd_images/${folder}/${actual}` : null;
}

function resolvePowerIconPath(killerName, getDirEntries) {
  const safeName = killerName.toLowerCase().replace(/ /g, '_').replace(/'/g, '');
  return resolveCandidateInFolder('powers', `${safeName}_power.png`, getDirEntries);
}

function resolveSpecialImagePath(categoryKey, entry, getDirEntries) {
  if (categoryKey === 'items') {
    const killerName = KILLER_POWER_ITEM_TO_KILLER[entry.internalId];
    if (killerName) return resolvePowerIconPath(killerName, getDirEntries);
    if (ITEM_PLACEHOLDERS.has(entry.internalId)) {
      return 'dbd_images/items/iconitems_missing.png';
    }
  }

  if (categoryKey === 'offerings' && entry.internalId === 'Winter2024Offering') {
    return 'dbd_images/offerings/iconfavors_mistletoes.png';
  }

  if (categoryKey === 'addons' && normalizeLocalPath(entry.image).endsWith('/Missing')) {
    return 'dbd_images/addons/iconaddon_missing.png';
  }

  return null;
}

function resolveImagePath(categoryKey, spec, entry, getDirEntries) {
  const image = entry.image;
  const direct = resolveExplicitLocalPath(spec, image, getDirEntries);
  if (direct) return direct;

  const special = resolveSpecialImagePath(categoryKey, entry, getDirEntries);
  if (special) return special;

  const normalized = normalizeLocalPath(image);
  const baseName = normalized.split('/').pop()?.split('?')[0];
  if (!baseName) return null;
  const withExt = baseName.includes('.') ? baseName : `${baseName}.png`;
  const aliasName = IMAGE_ALIASES[spec.type]?.[withExt.toLowerCase()];
  const candidates = [];
  const addCandidate = (value) => {
    if (value && !candidates.includes(value)) candidates.push(value);
  };

  addCandidate(aliasName);

  if (spec.type === 'Perk') {
    buildPerkCandidates(withExt).forEach(addCandidate);
  } else if (spec.type === 'Map') {
    buildMapCandidates(withExt).forEach(addCandidate);
  } else if (spec.type === 'Addon' || spec.type === 'Item' || spec.type === 'Offering') {
    addCandidate(withExt);
    addCandidate(withExt.toLowerCase());
    const justName = withExt.split('/').pop();
    addCandidate(justName);
    addCandidate(justName.toLowerCase());
    if (justName.toLowerCase().startsWith('t_ui_')) {
      addCandidate(justName.toLowerCase().replace('t_ui_', ''));
    }
  } else {
    addCandidate(withExt);
    addCandidate(withExt.toLowerCase());
    const nameMatch = withExt.match(/_(The[A-Za-z]+)_/);
    if (nameMatch && (spec.type === 'Killer' || spec.type === 'Survivor')) {
      const charName = nameMatch[1].toLowerCase();
      for (let i = 1; i <= 60; i += 1) {
        const prefix = spec.type === 'Killer' ? 'k' : 's';
        const num = i.toString().padStart(2, '0');
        addCandidate(`${prefix}${num}_${charName}_portrait.png`);
      }
    }
  }

  for (const candidate of candidates) {
    const resolved = resolveCandidateInFolder(spec.folder, candidate, getDirEntries);
    if (resolved) return resolved;
  }

  return null;
}

function normalizeDatabaseImages(database, options = {}) {
  const webRoot = options.webRoot || WEB_ROOT;
  const getDirEntries = getLookupCache(webRoot);
  const nextDatabase = JSON.parse(JSON.stringify(database));
  const unresolved = [];
  let changed = false;

  for (const [categoryKey, spec] of Object.entries(CATEGORY_SPECS)) {
    nextDatabase[categoryKey] = (nextDatabase[categoryKey] || []).map((entry) => {
      const resolvedPath = resolveImagePath(categoryKey, spec, entry, getDirEntries);
      if (!resolvedPath) {
        unresolved.push({
          category: categoryKey,
          id: entry.id,
          name: entry.name,
          image: entry.image
        });
        return entry;
      }
      if (entry.image !== resolvedPath) changed = true;
      return {
        ...entry,
        image: resolvedPath
      };
    });
  }

  return { database: nextDatabase, unresolved, changed };
}

function validateNormalizedDatabase(database, options = {}) {
  const webRoot = options.webRoot || WEB_ROOT;
  const issues = [];

  for (const [categoryKey, spec] of Object.entries(CATEGORY_SPECS)) {
    for (const entry of database[categoryKey] || []) {
      const image = normalizeLocalPath(entry.image);
      if (!image) {
        issues.push(`${categoryKey}/${entry.id}: missing image path`);
        continue;
      }
      if (/^https?:\/\//i.test(image) || /^UI\/Icons\//i.test(image)) {
        issues.push(`${categoryKey}/${entry.id}: non-local image path ${image}`);
        continue;
      }
      if (!isExplicitLocalImagePath(image)) {
        issues.push(`${categoryKey}/${entry.id}: unsupported local image path ${image}`);
        continue;
      }
      const allowedPrefix = getAllowedPrefixes(spec).some((prefix) => image.startsWith(prefix));
      if (!allowedPrefix) {
        issues.push(`${categoryKey}/${entry.id}: image path is outside allowed folders ${image}`);
        continue;
      }
      if (!fs.existsSync(path.join(webRoot, image))) {
        issues.push(`${categoryKey}/${entry.id}: local image file does not exist ${image}`);
      }
    }
  }

  return issues;
}

function formatUnresolved(entries) {
  return entries
    .map((entry) => `${entry.category}/${entry.id} (${entry.name}): ${entry.image}`)
    .join('\n- ');
}

function main() {
  const args = new Set(process.argv.slice(2));
  const checkMode = args.has('--check');
  const currentText = fs.readFileSync(DATABASE_PATH, 'utf8');
  const currentDatabase = readJson(DATABASE_PATH);
  const { database: nextDatabase, unresolved } = normalizeDatabaseImages(currentDatabase, { webRoot: WEB_ROOT });

  if (unresolved.length) {
    fail(`unable to resolve ${unresolved.length} image paths:\n- ${formatUnresolved(unresolved)}`);
  }

  const validationIssues = validateNormalizedDatabase(nextDatabase, { webRoot: WEB_ROOT });
  if (validationIssues.length) {
    fail(`normalized database has invalid image paths:\n- ${validationIssues.join('\n- ')}`);
  }

  const nextText = `${JSON.stringify(nextDatabase, null, 2)}\n`;
  if (checkMode) {
    if (currentText !== nextText) {
      fail('content/database.json image paths are stale. Run `npm run normalize:images`.');
    }
    console.log('normalize-images: content/database.json image paths are normalized.');
    return;
  }

  if (currentText === nextText) {
    console.log('normalize-images: content/database.json already normalized.');
    return;
  }

  fs.writeFileSync(DATABASE_PATH, nextText);
  console.log('normalize-images: wrote content/database.json');
}

if (require.main === module) {
  main();
} else {
  module.exports = {
    CATEGORY_SPECS,
    isExplicitLocalImagePath,
    normalizeLocalPath,
    normalizeDatabaseImages,
    validateNormalizedDatabase
  };
}
