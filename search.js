var db = new Dexie("clippingDB");
db.delete();
db.version(1).stores({
  items: 'url'
});
db.open();

var app = angular.module('schemaorg', ['angular.filter', 'user-profiles', 'search-facets', 'data-units'], function($provide) {
  // Fixes'history.pushState is not available in packaged apps' error message
  // Source: https://github.com/angular/angular.js/issues/11932
  $provide.decorator('$window', function($delegate) {
    Object.defineProperty($delegate, 'history', {
      get: function() {
        return null;
      }
    });
    return $delegate;
  });
});

app.filter('removeSeparator', function() {
  return function(input){
    var text = input.replace(/\s-\s/g, '|');
    var RegExp = /^([^|•:(+]+)/;
    var match = RegExp.exec(text);
    return match[1];
  };
});

app.factory('CustomSearch', function($q, $http) {
  var exec = function(apiKey, searchEngineId, keyword, page) {
    var defer = $q.defer();
    var offset = 10;
    var url = 'https://www.googleapis.com/customsearch/v1' +
      '?key=' + apiKey +
      '&cx=' + searchEngineId +
      '&q=' + keyword +
      '&start=' + (((page - 1) * offset) + 1) +
      '&num=10';
    $http.get(url).then(
      function(response) {
        defer.resolve(response.data.items);
      },
      function(err) {
        defer.reject(err);
      });
    return defer.promise;
  };
  return {
    exec: exec
  };
});

app.controller('SearchController', function($scope, profiles, facets, units, CustomSearch) {
  var profile = profiles['schemaorg'];
  var sc = this;
  sc.searchResults = [];
  sc.searchFacets = [];

  $scope.doSearch = function() {
    var userInput = $scope.keyword;
    if (userInput == null) {
      return;
    }
    var input = processUserInput(userInput, facets);
    var searchPromises = [];
    var pages = profile.pageLimit;
    var apiKey = profile.apiKey;
    var searchEngineId = profile.searchEngineId;
    var keyword = input.keyword;
    for (i = 1; i <= pages; i++) {
      var promise = CustomSearch.exec(apiKey, searchEngineId, keyword, i);
      searchPromises.push(promise);
    }
    Promise.all(searchPromises.map(settle)).then(results => {
      db.items.clear();
      results.filter(x => x.status === "resolved").forEach(output => {
        var topics = input.topics;
        var searchResults = output.value;
        storeResults(searchResults, topics, facets, units)
      });
      db.items.toArray(data => {
        sc.searchResults = data;

        var facetData = [];
        for (var i = 0; i < data.length; i++) {
          var itemProperties = data[i].properties;
            for (var j = 0; j < itemProperties.length; j++) {
              var propertyObj = itemProperties[j];
              var facet = {
                domain: propertyObj.domain,
                name: propertyObj.name,
                label: propertyObj.label + " " + getUnitLabel(propertyObj.unit),
                value: propertyObj.value,
                type: propertyObj.range,
                selected: false
              }
              facetData.push(facet);
            }
        }
        facetData = facetData.filter((facet, index, self) =>
            self.findIndex(t =>
                t.domain === facet.domain &&
                t.name === facet.name &&
                t.value === facet.value) === index);
        sc.searchFacets = facetData;
        $scope.$apply();
      });
    });
  }

  // Watch for selected facets
  $scope.$watch('sc.searchFacets|filter:{selected:true}', function(selectedFacets) {
    if (selectedFacets.length == 0) {
      db.items.toArray(data => {
        sc.searchResults = data;
        $scope.$apply();
      });
    } else {
      db.items.filter(data => {
        if (data.schemaorg.length == 0) {
          return true;
        } else {
          var output = data.properties.filter(item => {
            var answer = false;
            for (var i = 0; i < selectedFacets.length; i++) {
              var facet = selectedFacets[i];
              answer = answer || item.domain == facet.domain &&
                  item.name == facet.name &&
                  item.value == facet.value;
            }
            return answer;
          });
          return output.length != 0
        }
      }).toArray(data => {
        sc.searchResults = data;
        $scope.$apply();
      });
    }
  }, true);
});

function processUserInput(input, facets) {
  var keyword_split = input.split('#');
  var keyword = keyword_split[0];
  var topics = keyword_split.filter(str => { return str != keyword });
  if (topics.length == 0) {
    topics = Object.keys(facets);
  }
  return {
    keyword: keyword,
    topics: topics
  }
}

// Solution for handling request failure gracefully in Promise.all
// Source: https://stackoverflow.com/questions/31424561/wait-until-all-es6-promises-complete-even-rejected-promises
function settle(promise) {
  return promise.then(function(v){ return {value:v, status: "resolved" }},
                      function(e){ return {value:e, status: "rejected" }});
}

function storeResults(searchResults, topics, facets, units) {
  if (searchResults != null) {
    searchResults.forEach(resultItem => {
      var pkItem = resultItem.link;
      storeBasicData(pkItem, resultItem);
      storeSchemaOrgData(pkItem, resultItem, topics, facets, units);
    });
  }
}

function storeBasicData(pkItem, resultItem) {
  db.items.add({
    url: pkItem,
    title: resultItem.title,
    description: resultItem.snippet,
    properties: [],
    schemaorg: [],
  }).catch(err => {
    // console.error(err);
  });
}

function storeSchemaOrgData(pkItem, resultItem, topics, facets, units) {
  for (var i = 0; i < topics.length; i++) {
    var topic = topics[i];
    var schemaOrgData = getSchemaOrgData(resultItem, topic);
    if (schemaOrgData != null) {
      updateTableWithSchemaOrgData(pkItem, schemaOrgData);
      updateTableWithExtraProperties(pkItem, schemaOrgData, topic, facets, units);
    }
  }
}

function updateTableWithSchemaOrgData(pkItem, schemaOrgData) {
  db.items.where('url').equals(pkItem).modify(item => {
    item.schemaorg.push(schemaOrgData)
  }).catch(err => {
    // console.error(err);
  });
}

function updateTableWithExtraProperties(pkItem, schemaOrgData, topic, facets, units) {
  db.items.where('url').equals(pkItem).modify(item => {
    var topicFacet = facets[topic];
    for (var i = 0; i < topicFacet.terms.length; i++) {
      var term = topicFacet.terms[i];
      var label = topicFacet.labels[i];
      var dtype = topicFacet.dtype[i];
      var value = schemaOrgData[topic][term];
      if (value != null) {
        var property = {
          domain: topic,
          range: dtype,
          name: term,
          label: label,
          value: refineValue(value, dtype, units[term]),
          unit: units[term]
        }
        item.properties.push(property);
      }
    }
  }).catch(err => {
    // console.error(err);
  });
}

function getSchemaOrgData(obj, topic) {
  if (!obj.hasOwnProperty('pagemap')) {
    return;
  }
  var pagemap = obj.pagemap;
  if (!pagemap.hasOwnProperty(topic)) {
    return;
  }
  var topicArray = pagemap[topic];
  var topicAttributes = findBestData(topicArray);
  var topicObject = {};
  topicObject[topic] = topicAttributes;
  return topicObject;
}

function findBestData(arr) {
  var toReturn = {};
  var bestInfoSize = -1;
  for (var i = 0; i < arr.length; i++) {
    var topicObject = arr[i];
    var infoSize = Object.keys(topicObject).length;
    if (infoSize > bestInfoSize) {
      toReturn = topicObject;
      bestInfoSize = infoSize;
    }
  }
  return toReturn;
}

function refineValue(value, dtype, unit) {
  if (dtype === "numeric") {
    return refineNumericData(value, unit);
  } else if (dtype === "duration") {
    return refineDurationData(value, unit);
  }
  return value;
}

function refineNumericData(value, unit) {
  if (unit != null) {
    try {
      return Qty(value).to(unit).scalar;
    } catch (err) {
      return autoFixNumericData(value);
    }
  } else {
    return autoFixNumericData(value);
  }
}

function refineDurationData(value, unit) {
  var duration = moment.duration(value);
  if (duration._milliseconds != 0) {
    return duration.as(unit);
  } else {
    return autoFixDurationData(value);
  }
}

function autoFixNumericData(value) {
  var numericValue = getNumberOnly(value)
  console.log("INFO: Applying an auto-fix for [numeric] data by converting " +
      "\"" + value + "\" to \"" + numericValue + "\"");
  return numericValue;
}

function autoFixDurationData(value) {
  var durationValue = getNumberOnly(value);
  console.log("INFO: Applying an auto-fix for [duration] data by converting " +
      "\"" + value + "\" to \"" + durationValue + "\"");
  return durationValue;
}

function getNumberOnly(text) {
  var RegExp = /(\d+([\/\.]\d+)?)/;
  var match = RegExp.exec(text);
  return evalNumber(match[1]);
}

function evalNumber(number) {
  var value = number;
  var y = number.split(' ');
  if (y.length > 1) {
    var z = y[1].split('/');
    value = +y[0] + (z[0] / z[1]);
  } else {
    var z = y[0].split('/');
    if (z.length > 1) {
      value = z[0] / z[1];
    }
  }
  return +value;
}

function getUnitLabel(unit) {
  if (unit == null) {
    return "";
  } else {
    return "(" + unit + ")"
  }
}
