Pod::Spec.new do |s|
  s.name           = 'BackgroundTime'
  s.version        = '1.0.0'
  s.summary        = 'Asks iOS for time to finish a Drona build after the app leaves the screen.'
  s.description    = s.summary
  s.author         = 'Overload'
  s.homepage       = 'https://docs.expo.dev/modules/'
  s.platforms      = { :ios => '15.1' }
  s.source         = { git: '' }
  s.static_framework = true

  s.dependency 'ExpoModulesCore'

  s.pod_target_xcconfig = { 'DEFINES_MODULE' => 'YES' }
  s.source_files = '**/*.{h,m,mm,swift}'
end
