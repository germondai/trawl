package com.germondai.trawl.mobile

import android.content.Context
import android.content.res.Resources
import org.json.JSONObject
import java.util.Locale
import java.text.NumberFormat

/** Bundled catalogs also work in the runtime process without an Activity or WebView. */
object Localizations {
    private val supported = setOf("en", "cs", "sk", "pl", "de", "fr")
    private val catalogs = mutableMapOf<String, JSONObject>()
    @Volatile var language: String = "system"
        private set
    fun setLanguage(value: String) { language = if(value == "system" || value in supported) value else "en" }
    fun locale(): String {
        if(language != "system") return language
        val languages = Resources.getSystem().configuration.locales
        for(index in 0 until languages.size()) {
            val candidate = languages[index].language.lowercase(Locale.ROOT)
            if(candidate in supported) return candidate
        }
        return "en"
    }
    @Synchronized private fun catalog(context: Context, locale: String): JSONObject =
        catalogs.getOrPut(locale) { context.assets.open("$locale.json").bufferedReader().use { JSONObject(it.readText()) } }
    fun text(context: Context, key: String, vararg arguments: Pair<String, Any>): String {
        val value = catalog(context, locale()).opt(key) ?: catalog(context, "en").opt(key)
        val source = if(value is String) value else key
        val parameters = arguments.toMap()
        return Regex("\\{([a-zA-Z][a-zA-Z0-9_]*)\\}").replace(source) { match ->
            when(val parameter = parameters[match.groupValues[1]]) {
                is Number -> NumberFormat.getIntegerInstance(Locale.forLanguageTag(locale())).format(parameter)
                null -> match.value
                else -> parameter.toString()
            }
        }
    }
}
